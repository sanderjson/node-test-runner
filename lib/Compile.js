//@flow

const path = require('path'),
  elmCompiler = require('./ElmCompiler'),
  spawn = require('cross-spawn'),
  packageInfo = require('../package.json');

function compile(
  testFile /*: string */,
  dest /*: string */,
  verbose /*: boolean */,
  pathToElmBinary /*: string */,
  report /*: string */
) /*: Promise<void> */ {
  return new Promise((resolve, reject) => {
    const compileProcess = elmCompiler.compile([testFile], {
      output: dest,
      verbose: verbose,
      spawn: spawnCompiler(report),
      pathToElm: pathToElmBinary,
      processOpts: processOptsForReporter(report),
    });

    compileProcess.on('close', function (exitCode) {
      if (exitCode !== 0) {
        reject(new Error(`\`elm make\` failed with exit code ${exitCode}.`));
      } else {
        resolve();
      }
    });
  });
}

function getGeneratedCodeDir(projectRootDir /*: string */) /*: string */ {
  return path.join(
    projectRootDir,
    'elm-stuff',
    'generated-code',
    'elm-community',
    'elm-test',
    packageInfo.version
  );
}

function getTestRootDir(projectRootDir /*: string */) /*: string */ {
  return path.resolve(path.join(projectRootDir, 'tests'));
}

function compileSources(
  testFilePaths /*: Array<string> */,
  projectRootDir /*: string */,
  verbose /*: boolean */,
  pathToElmBinary /*: string */,
  report /*: string */
) /*: Promise<void> */ {
  return new Promise((resolve, reject) => {
    const compilerReport = report === 'json' ? report : undefined;

    const compileProcess = elmCompiler.compile(testFilePaths, {
      output: '/dev/null',
      cwd: projectRootDir,
      verbose: verbose,
      spawn: spawnCompiler(report),
      pathToElm: pathToElmBinary,
      report: compilerReport,
      processOpts: processOptsForReporter(report),
    });

    compileProcess.on('close', function (exitCode) {
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new Error(`\`elm make\` failed with exit code ${exitCode}.`));
      }
    });
  });
}

function spawnCompiler(report /*: string */) {
  return (
    pathToElm /*: string */,
    processArgs /*: Array<string> */,
    processOpts /*: Object */
  ) => {
    const finalOpts = Object.assign({ env: process.env }, processOpts, {
      stdio: [
        process.stdin,
        report === 'console' ? process.stdout : 'ignore',
        process.stderr,
      ],
    });

    return spawn(pathToElm, processArgs, finalOpts);
  };
}

function processOptsForReporter(reporter) {
  if (isMachineReadableReporter(reporter)) {
    return { env: process.env, stdio: ['ignore', 'ignore', process.stderr] };
  } else {
    return { env: process.env };
  }
}

function isMachineReadableReporter(reporter /*: string */) /*: boolean */ {
  return reporter === 'json' || reporter === 'junit';
}

module.exports = {
  compile,
  compileSources,
  getTestRootDir,
  getGeneratedCodeDir,
  isMachineReadableReporter,
};
