const test = require('tape');
const sh = require('shelljs');
const runTasks = require('../lib/tasks');
const {
  GitRepoError,
  GitRemoteUrlError,
  GitCleanWorkingDirError,
  GitUpstreamError,
  GithubTokenError,
  InvalidVersionError,
  DistRepoStageDirError
} = require('../lib/errors');

const tmp = 'test/resources/tmp';
const tmpBare = 'test/resources/bare.git';

const tasks = options => {
  return runTasks(
    Object.assign(
      {
        config: false,
        'non-interactive': true,
        'disable-metrics': true
      },
      options
    )
  );
};

const prepare = () => {
  sh.exec(`git init --bare ${tmpBare}`);
  sh.exec(`git clone ${tmpBare} ${tmp}`);
  sh.pushd('-q', tmp);
  // sh.exec('git remote add origin foo');
  sh.touch('file1');
  sh.exec('git add file1');
  sh.exec('git commit -am "Add file1"');
};

const cleanup = () => {
  sh.popd('-q');
  sh.rm('-rf', [tmp, tmpBare]);
};

test('should throw when not a Git repository', async t => {
  sh.pushd('-q', '..');
  await t.shouldBailOut(tasks(), GitRepoError, /Not a git repository/);
  sh.popd('-q');
  t.end();
});

test('should throw if there is no remote Git url', async t => {
  prepare();
  sh.exec('git remote remove origin');
  await t.shouldBailOut(tasks(), GitRemoteUrlError, /Could not get remote Git url/);
  cleanup();
  t.end();
});

test('should throw if working dir is not clean', async t => {
  prepare();
  sh.exec('rm file1');
  await t.shouldBailOut(tasks(), GitCleanWorkingDirError, /Working dir must be clean/);
  cleanup();
  t.end();
});

test('should throw if no upstream is configured', async t => {
  prepare();
  sh.exec('git checkout -b foo');
  await t.shouldBailOut(tasks(), GitUpstreamError, /No upstream configured for current branch/);
  cleanup();
  t.end();
});

test('should throw if no GitHub token environment variable is set', async t => {
  prepare();
  await t.shouldBailOut(
    tasks({
      github: {
        release: true,
        tokenRef: 'GITHUB_FOO'
      }
    }),
    GithubTokenError,
    /Environment variable "GITHUB_FOO" is required for GitHub releases/
  );
  cleanup();
  t.end();
});

test('should throw if invalid increment value is provided', async t => {
  prepare();
  await t.shouldBailOut(
    tasks({
      increment: 'mini'
    }),
    InvalidVersionError,
    /invalid version was provided/
  );
  cleanup();
  t.end();
});

test('should throw if not a subdir is provided for dist.stageDir', async t => {
  prepare();
  await t.shouldBailOut(
    tasks({
      dist: {
        repo: 'foo',
        stageDir: '..'
      }
    }),
    DistRepoStageDirError,
    /`dist.stageDir` \(".."\) must resolve to a sub directory/
  );
  cleanup();
  t.end();
});
