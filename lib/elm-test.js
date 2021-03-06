// @flow

var packageInfo = require('../package.json');
var chalk = require('chalk');
var Install = require('./Install.js');
var Compile = require('./Compile.js');
var Generate = require('./Generate.js');
var processTitle = 'elm-test';
var which = require('which');

process.title = processTitle;

function clearConsole() {
  process.stdout.write(
    process.platform === 'win32' ? '\x1B[2J\x1B[0f' : '\x1B[2J\x1B[3J\x1B[H'
  );
}

process.on('uncaughtException', function (error) {
  if (/ an argument in Javascript/.test(error)) {
    // Handle arg mismatch between js and elm code. Expected message from Elm:
    // "You are giving module `Main` an argument in JavaScript.
    // This module does not take arguments though! You probably need to change the
    // initialization code to something like `Elm.Test.Generated.Main.fullscreen()`]"
    console.error('Error starting the node-test-runner.');
    console.error(
      "Please check your Javascript 'elm-test' and Elm 'node-test-runner' package versions are compatible"
    );
    process.exit(1);
  } else {
    console.error('Unhandled exception while running the tests:', error);
    process.exit(1);
  }
});

var fs = require('fs-extra'),
  os = require('os'),
  glob = require('glob'),
  path = require('path'),
  minimist = require('minimist'),
  chokidar = require('chokidar'),
  Runner = require('./Runner.js'),
  Supervisor = require('./Supervisor.js');

// Check Node.js version.
const nodeVersionMin = '10.13.0';
const nodeVersionString = process.versions.node;

if (
  nodeVersionString.localeCompare(nodeVersionMin, 'en', { numeric: true }) < 0
) {
  console.error(`You are using Node.js v${nodeVersionString}.`);
  console.error(
    `elm-test requires Node.js v${nodeVersionMin} or greater - upgrade the installed version of Node.js and try again!`
  );
  process.exit(1);
}

var args = minimist(process.argv.slice(2), {
  boolean: ['warn', 'version', 'help', 'watch'],
  string: ['compiler', 'seed', 'report', 'fuzz'],
});
var processes = Math.max(1, os.cpus().length);

function flatMap(array, f) {
  return array.reduce((result, item) => result.concat(f(item)), []);
}

// Recursively search directories for *.elm files, excluding elm-stuff/
function resolveFilePath(filename) {
  var candidates;

  if (!fs.existsSync(filename)) {
    candidates = [];
  } else if (fs.lstatSync(filename).isDirectory()) {
    candidates = flatMap(
      glob.sync('/**/*.elm', {
        root: filename,
        nocase: true,
        ignore: '/**/elm-stuff/**',
        nodir: true,
      }),
      resolveFilePath
    );
  } else {
    candidates = [path.resolve(filename)];
  }

  // Exclude everything having anything to do with elm-stuff
  return candidates.filter(function (candidate) {
    return candidate.split(path.sep).indexOf('elm-stuff') === -1;
  });
}

let pathToElmBinary;

if (args.compiler === undefined) {
  try {
    pathToElmBinary = which.sync('elm');
  } catch (error) {
    console.error(
      `Cannot find elm executable, make sure it is installed.
(If elm is not on your path or is called something different the --compiler flag might help.)`
    );
    // Flow does not understand that `process.exit()` diverges. We add an
    // unconditional throw here (that can never run) to help flow out.
    throw process.exit(1);
  }
} else {
  try {
    pathToElmBinary = path.resolve(which.sync(args.compiler));
  } catch (error) {
    console.error('The elm executable passed to --compiler must exist.');
    // See above.
    throw process.exit(1);
  }
}

function printUsage(str) {
  console.log('Usage: elm-test ' + str + '\n');
}

if (args.help) {
  var exampleGlob = path.join('tests', '**', '*.elm');

  [
    'init # Create example tests',
    'install PACKAGE # Like `elm install PACKAGE`, except it installs to "test-dependencies" in your elm.json',
    'TESTFILES # Run TESTFILES, for example ' + exampleGlob,
    '[--compiler /path/to/compiler] # Run tests',
    '[--seed integer] # Run with initial fuzzer seed',
    '[--fuzz integer] # Run with each fuzz test performing this many iterations',
    '[--report json, junit, or console (default)] # Print results to stdout in given format',
    '[--version] # Print version string and exit',
    '[--watch] # Run tests on file changes',
  ].forEach(printUsage);

  process.exit(0);
}

if (args.version) {
  console.log(require(path.join(__dirname, '..', 'package.json')).version);
  process.exit(0);
}

if (args._[0] === 'install') {
  var packageName = args._[1];

  if (typeof packageName === 'string') {
    if (!fs.existsSync('elm.json')) {
      console.error(
        '`elm-test install` must be run in the same directory as an existing elm.json file!'
      );
      process.exit(1);
    }

    Install.install(pathToElmBinary, packageName);

    process.exit(0);
  } else {
    console.error(
      'What package should I install? I was expecting something like this:\n\n    elm-test install elm/regex\n'
    );
    process.exit(1);
  }
} else if (args._[0] == 'init') {
  if (!fs.existsSync('elm.json')) {
    console.error(
      '`elm-test init` must be run in the same directory as an existing elm.json file! You can run `elm init` to initialize one.'
    );
    process.exit(1);
  }

  Install.install(pathToElmBinary, 'elm-explorations/test');
  fs.mkdirpSync('tests');
  fs.copySync(
    path.join(__dirname, '..', 'templates', 'tests', 'Example.elm'),
    'tests/Example.elm'
  );

  console.log(
    '\nCheck out the documentation for getting started at https://package.elm-lang.org/packages/elm-explorations/test/latest'
  );

  process.exit(0);
}

let runsExecuted = 0;

function runTests(generatedCodeDir /*: string */, testFile /*: string */) {
  const dest = path.resolve(path.join(generatedCodeDir, 'elmTestOutput.js'));

  // Incorporate the process PID into the socket name, so elm-test processes can
  // be run parallel without accidentally sharing each others' sockets.
  //
  // See https://github.com/rtfeldman/node-test-runner/pull/231
  // Also incorporate a salt number into it on Windows, to avoid EADDRINUSE -
  // see https://github.com/rtfeldman/node-test-runner/issues/275 - because the
  // alternative approach of deleting the file before creating a new one doesn't
  // work on Windows. We have to let Windows clean up the named pipe. This is
  // essentially a band-aid fix. The alternative is to rewrite a ton of stuff.
  runsExecuted++;
  const pipeFilename =
    process.platform === 'win32'
      ? '\\\\.\\pipe\\elm_test-' + process.pid + '-' + runsExecuted
      : '/tmp/elm_test-' + process.pid + '.sock';

  return Compile.compile(
    testFile,
    dest,
    args.verbose,
    pathToElmBinary,
    args.report
  )
    .then(function () {
      return Generate.prepareCompiledJsFile(pipeFilename, dest).then(
        function () {
          return Supervisor.run(
            packageInfo.version,
            pipeFilename,
            report,
            processes,
            dest,
            args.watch,
            Compile.isMachineReadableReporter(report)
          );
        }
      );
    })
    .catch(function (error) {
      console.error('Compilation failed for', testFile);
      return Promise.reject(error);
    });
}

function globify(filename) {
  return glob.sync(filename, {
    nocase: true,
    ignore: '**/elm-stuff/**',
    nodir: false,
    absolute: true,
  });
}

function globifyWithRoot(root, filename) {
  return glob.sync(filename, {
    root: root,
    nocase: true,
    ignore: '**/elm-stuff/**',
    nodir: false,
    absolute: true,
  });
}

function resolveGlobs(fileGlobs) {
  let globs;

  if (fileGlobs.length > 0) {
    globs = flatMap(fileGlobs, globify);
  } else {
    const root = process.cwd();

    globs = globifyWithRoot(root, 'test?(s)/**/*.elm');
  }

  return flatMap(globs, resolveFilePath);
}

function getGlobsToWatch(elmJson) {
  let sourceDirectories;
  if (elmJson['type'] === 'package') {
    sourceDirectories = ['src'];
  } else {
    sourceDirectories = elmJson['source-directories'];
  }
  return [...sourceDirectories, 'tests'].map(function (sourceDirectory) {
    return path.posix.join(sourceDirectory, '**', '*.elm');
  });
}

let report;

if (
  args.report === 'console' ||
  args.report === 'json' ||
  args.report === 'junit'
) {
  report = args.report;
} else if (args.report !== undefined) {
  console.error(
    "The --report option must be given either 'console', 'junit', or 'json'"
  );
  process.exit(1);
} else {
  report = 'console';
}

function infoLog(msg) {
  if (report === 'console') {
    console.log(msg);
  }
}

// It's important to globify all the arguments.
// On Bash 4.x (or zsh), if you give it a glob as its last argument, Bash
// translates that into a list of file paths. On bash 3.x it's just a string.
// Ergo, globify all the arguments we receive.
const isMake = args._[0] === 'make';
const testFileGlobs = isMake ? args._.slice(1) : args._;
const testFilePaths = resolveGlobs(testFileGlobs);
const projectRootDir = process.cwd();
const generatedCodeDir = Compile.getGeneratedCodeDir(projectRootDir);
const hasBeenGivenCustomGlobs = testFileGlobs.length > 0;

const elmJsonPath = path.resolve(path.join(projectRootDir, 'elm.json'));
let projectElmJson;

try {
  projectElmJson = fs.readJsonSync(elmJsonPath);
} catch (err) {
  console.error('Error reading elm.json: ' + err.message);
  throw process.exit(1);
}

const isPackageProject = projectElmJson.type === 'package';

if (isMake) {
  Generate.generateElmJson(
    projectRootDir,
    generatedCodeDir,
    hasBeenGivenCustomGlobs,
    elmJsonPath,
    projectElmJson
  );

  Compile.compileSources(
    testFilePaths,
    generatedCodeDir,
    args.verbose,
    pathToElmBinary,
    args.report
  )
    .then(function () {
      process.exit(0);
    })
    .catch(function () {
      process.exit(1);
    });
} else {
  if (testFilePaths.length === 0) {
    console.error(noFilesFoundError(testFileGlobs));
    process.exit(1);
  }

  const [generatedSrc, sourceDirs] = Generate.generateElmJson(
    projectRootDir,
    generatedCodeDir,
    hasBeenGivenCustomGlobs,
    elmJsonPath,
    projectElmJson
  );

  function run() {
    // This compiles all the tests so that we generate *.elmi files for them,
    // which we can then read to determine which tests need to be run.
    return Runner.findTests(testFilePaths, sourceDirs, isPackageProject)
      .then(function (testModules) {
        process.chdir(generatedCodeDir);

        const mainFile = Generate.generateMainModule(
          parseInt(args.fuzz),
          parseInt(args.seed),
          args.report,
          testFileGlobs,
          testFilePaths,
          testModules,
          generatedSrc,
          processes
        );

        return runTests(generatedCodeDir, mainFile);
      })
      .catch(function (err) {
        console.error(err.message);
        if (!args.watch) {
          process.exit(1);
        }
      })
      .then(function () {
        console.log(chalk.blue('Watching for changes...'));
      });
  }

  var currentRun = run();

  if (args.watch) {
    clearConsole();
    infoLog('Running in watch mode');

    var globsToWatch = getGlobsToWatch(projectElmJson);
    var watcher = chokidar.watch(globsToWatch, {
      awaitWriteFinish: {
        stabilityThreshold: 500,
      },
      ignoreInitial: true,
      ignored: /(\/|^)elm-stuff(\/|$)/,
      cwd: projectRootDir,
    });

    var eventNameMap = {
      add: 'added',
      addDir: 'added',
      change: 'changed',
      unlink: 'removed',
      unlinkDir: 'removed',
    };

    watcher.on('all', function (event, filePath) {
      var eventName = eventNameMap[event] || event;
      clearConsole();
      infoLog('\n' + filePath + ' ' + eventName + '. Rebuilding!');

      // TODO if a previous run is in progress, wait until it's done.
      currentRun = currentRun.then(run);
    });
  }
}

function noFilesFoundError(testFileGlobs) {
  return testFileGlobs.length === 0
    ? `
No .elm files found in the tests/ directory.

To generate some initial tests to get things going: elm-test init

Alternatively, if your project has tests in a different directory,
try calling elm-test with a glob such as: elm-test "src/**/*Tests.elm"
      `.trim()
    : `
No files found matching:

${testFileGlobs.join('\n')}

Are the above patterns correct? Maybe try running elm-test with no arguments?
      `.trim();
}
