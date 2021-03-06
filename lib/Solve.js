// @flow

const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');
const spawn = require('cross-spawn');

function sha1(string) {
  return crypto.createHash('sha1').update(string).digest('hex');
}

function getDependenciesCached(
  generatedCodeDir /*: string */,
  elmJsonPath /*: string */,
  projectElmJson /*: any */
) /*: { direct: { [string]: string }, indirect: { [string]: string } } */ {
  const hash = sha1(
    JSON.stringify({
      dependencies: projectElmJson.dependencies,
      'test-dependencies': projectElmJson['test-dependencies'],
    })
  );

  const cacheFile = path.join(generatedCodeDir, `dependencies.${hash}.json`);

  try {
    return fs.readJsonSync(cacheFile);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(
        `Ignoring bad dependencies cache file:\n\n${error.message}\n\nPlease report this issue: https://github.com/rtfeldman/node-test-runner/issues/new`
      );
    }
  }

  const dependencies = getDependencies(elmJsonPath);

  fs.writeFileSync(cacheFile, dependencies);

  return JSON.parse(dependencies);
}

function getDependencies(elmJsonPath) {
  var result = spawn.sync(
    'elm-json',
    [
      'solve',
      '--test',
      '--extra',
      'elm/core',
      'elm/json',
      'elm/time',
      'elm/random',
      '--',
      elmJsonPath,
    ],
    {
      encoding: 'utf8',
    }
  );

  if (result.status != 0) {
    console.error(`Failed to run \`elm-json solve\`:\n${result.stderr}`);
    process.exit(1);
  }

  return result.stdout;
}

module.exports = { getDependenciesCached };
