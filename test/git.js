const test = require('tape');
const sinon = require('sinon');
const sh = require('shelljs');
const semver = require('semver');
const mockStdIo = require('mock-stdio');
const { readFile, readJSON } = require('./util/index');
const Shell = require('../lib/shell');
const Git = require('../lib/git');

const tmp = 'test/resources/tmp';
const tmpBare = 'test/resources/bare.git';

const shell = new Shell();
const gitClient = new Git();

test('isGitRepo', async t => {
  t.ok(await gitClient.isGitRepo());
  const tmp = '..';
  sh.pushd('-q', tmp);
  t.notOk(await gitClient.isGitRepo());
  sh.popd('-q');
  t.end();
});

test('isInGitRootDir', async t => {
  sh.mkdir(tmp);
  sh.pushd('-q', tmp);
  t.notOk(await gitClient.isInGitRootDir());
  sh.exec('git init');
  t.ok(await gitClient.isInGitRootDir());
  sh.popd('-q');
  sh.rm('-rf', tmp);
  t.end();
});

test('hasUpstream', async t => {
  sh.mkdir(tmp);
  sh.pushd('-q', tmp);
  sh.exec('git init');
  sh.touch('file1');
  sh.exec('git add file1');
  sh.exec('git commit -am "Add file1"');
  t.notOk(await gitClient.hasUpstreamBranch());
  sh.popd('-q');
  sh.rm('-rf', tmp);
  t.end();
});

test('getBranchName', async t => {
  sh.mkdir(tmp);
  sh.pushd('-q', tmp);
  sh.exec('git init');
  t.equal(await gitClient.getBranchName(), null);
  sh.exec('git checkout -b feat');
  sh.touch('file1');
  sh.exec('git add file1');
  sh.exec('git commit -am "Add file1"');
  t.equal(await gitClient.getBranchName(), 'feat');
  sh.popd('-q');
  sh.rm('-rf', tmp);
  t.end();
});

test('tagExists + isWorkingDirClean', async t => {
  sh.mkdir(tmp);
  sh.pushd('-q', tmp);
  sh.exec('git init');
  t.notOk(await gitClient.tagExists('1.0.0'));
  sh.touch('file1');
  t.notOk(await gitClient.isWorkingDirClean());
  sh.exec('git add file1');
  sh.exec('git commit -am "Add file1"');
  sh.exec('git tag 1.0.0');
  t.ok(await gitClient.tagExists('1.0.0'));
  t.ok(await gitClient.isWorkingDirClean());
  sh.popd('-q');
  sh.rm('-rf', tmp);
  t.end();
});

test('getRemoteUrl', async t => {
  sh.mkdir(tmp);
  sh.pushd('-q', tmp);
  sh.exec(`git init`);

  {
    const gitClient = new Git({ pushRepo: 'origin' });
    t.equal(await gitClient.getRemoteUrl(), null);
    sh.exec(`git remote add origin foo`);
    t.equal(await gitClient.getRemoteUrl(), 'foo');
  }
  {
    const gitClient = new Git({ pushRepo: 'another' });
    t.equal(await gitClient.getRemoteUrl(), null);
    sh.exec(`git remote add another bar`);
    t.equal(await gitClient.getRemoteUrl(), 'bar');
  }
  {
    const gitClient = new Git({ pushRepo: 'git://github.com/webpro/release-it.git' });
    t.equal(await gitClient.getRemoteUrl(), 'git://github.com/webpro/release-it.git');
  }

  sh.popd('-q');
  sh.rm('-rf', tmp);
  t.end();
});

test('clone + stage + commit + tag + push', async t => {
  sh.exec(`git init --bare ${tmpBare}`);
  const gitClient = new Git();
  await gitClient.clone(tmpBare, tmp);
  await gitClient.init();
  sh.cp('package.json', tmp);
  sh.pushd('-q', tmp);
  await gitClient.stage('package.json');
  await gitClient.commit({ message: 'Add package.json' });
  const { version } = await readJSON('package.json');
  {
    sh.exec(`git tag ${version}`);
    const latestTag = await gitClient.getLatestTag();
    t.ok(await gitClient.isGitRepo());
    t.equal(version, latestTag);
  }
  {
    sh.exec('echo line >> file1');
    await gitClient.stage('file1');
    await gitClient.commit({ message: 'Update file1' });
    sh.exec('npm --no-git-tag-version version patch');
    await gitClient.stage('package.json');
    const nextVersion = semver.inc(version, 'patch');
    await gitClient.commit({ message: `Release v${nextVersion}` });
    await gitClient.tag({ name: `v${nextVersion}`, annotation: `Release v${nextVersion}` });
    const manifest = await readJSON('package.json');
    const latestTag = await gitClient.getLatestTag();
    t.equal(manifest.version, latestTag);
    await gitClient.push();
    const status = sh.exec('git status -uno');
    t.ok(status.includes('nothing to commit'));
  }
  sh.popd('-q');
  sh.rm('-rf', [tmpBare, tmp]);
  t.end();
});

test('push', async t => {
  sh.exec(`git init --bare ${tmpBare}`);
  sh.exec(`git clone ${tmpBare} ${tmp}`);
  sh.pushd('-q', tmp);
  const gitClient = new Git({ shell });
  await gitClient.init();
  sh.exec('echo line >> file');
  await gitClient.stage('file');
  await gitClient.commit({ message: 'Add file' });
  const spy = sinon.spy(shell, 'run');
  await gitClient.push();
  t.equal(spy.lastCall.args[0].trim(), 'git push --follow-tags  origin');
  const actual = sh.exec('git ls-tree -r HEAD --name-only', { cwd: '../bare.git' });
  t.equal(actual.trim(), 'file');
  sh.popd('-q');
  sh.rm('-rf', [tmpBare, tmp]);
  spy.restore();
  t.end();
});

test('push (pushRepo url)', async t => {
  sh.exec(`git init --bare ${tmpBare}`);
  sh.exec(`git clone ${tmpBare} ${tmp}`);
  sh.pushd('-q', tmp);
  const gitClient = new Git({ pushRepo: 'https://host/repo.git', shell });
  await gitClient.init();
  sh.exec('echo line >> file');
  await gitClient.stage('file');
  await gitClient.commit({ message: 'Add file' });
  const spy = sinon.spy(shell, 'run');
  try {
    await gitClient.push();
  } catch (err) {
    t.equal(spy.lastCall.args[0].trim(), 'git push --follow-tags  https://host/repo.git');
  }
  sh.popd('-q');
  sh.rm('-rf', [tmpBare, tmp]);
  spy.restore();
  t.end();
});

test('push (pushRepo not "origin")', async t => {
  sh.exec(`git init --bare ${tmpBare}`);
  sh.exec(`git clone ${tmpBare} ${tmp}`);
  const gitClient = new Git();
  await gitClient.init();
  sh.pushd('-q', tmp);
  sh.exec(`git remote add upstream ${sh.exec('git remote get-url origin')}`);
  {
    const gitClient = new Git({ pushRepo: 'upstream', shell });
    sh.exec('echo line >> file');
    await gitClient.stage('file');
    await gitClient.commit({ message: 'Add file' });
    const spy = sinon.spy(shell, 'run');
    await gitClient.push();
    t.equal(spy.lastCall.args[0].trim(), 'git push --follow-tags  upstream');
    const actual = sh.exec('git ls-tree -r HEAD --name-only', { cwd: '../bare.git' });
    t.equal(actual.trim(), 'file');
    {
      sh.exec(`git checkout -b foo`);
      sh.exec('echo line >> file');
      await gitClient.stage('file');
      await gitClient.commit({ message: 'Add file' });
      await gitClient.push();
      t.equal(spy.lastCall.args[0].trim(), 'git push --follow-tags  -u upstream foo');
      t.equal(await spy.lastCall.returnValue, "Branch 'foo' set up to track remote branch 'foo' from 'upstream'.");
    }
    spy.restore();
  }
  sh.popd('-q');
  sh.rm('-rf', [tmpBare, tmp]);
  t.end();
});

test('status', async t => {
  sh.mkdir(tmp);
  sh.pushd('-q', tmp);
  sh.exec('git init');
  sh.exec('echo line >> file1');
  sh.exec('git add file1');
  sh.exec('git commit -am "Add file1"');
  sh.exec('echo line >> file1');
  sh.exec('echo line >> file2');
  sh.exec('git add file2');
  t.equal(await gitClient.status(), 'M file1\nA  file2');
  sh.popd('-q');
  sh.rm('-rf', tmp);
  t.end();
});

test('reset', async t => {
  sh.mkdir(tmp);
  sh.pushd('-q', tmp);
  sh.exec('git init');
  sh.exec('echo line >> file1');
  sh.exec('git add file1');
  sh.exec('git commit -am "Add file1"');
  sh.exec('echo line >> file1');
  t.ok(/^line\s*line\s*$/.test(await readFile('file1')));
  await gitClient.reset('file1');
  t.ok(/^line\s*$/.test(await readFile('file1')));
  mockStdIo.start();
  await gitClient.reset(['file2, file3']);
  const { stdout } = mockStdIo.end();
  t.ok(/Could not reset file2, file3/.test(stdout));
  sh.popd('-q');
  sh.rm('-rf', tmp);
  t.end();
});

test('getChangelog', async t => {
  sh.mkdir(tmp);
  sh.pushd('-q', tmp);
  sh.exec('git init');
  sh.exec('echo line >> file && git add file && git commit -m "First commit"');
  sh.exec('echo line >> file && git add file && git commit -m "Second commit"');

  await t.shouldReject(gitClient.getChangelog('git log --invalid'), /Could not create changelog/);

  {
    const changelog = await gitClient.getChangelog('git log --pretty=format:"* %s (%h)"');
    t.ok(/^\* Second commit \(\w{7}\)\n\* First commit \(\w{7}\)$/.test(changelog));
  }

  {
    sh.exec('git tag 1.0.0');
    sh.exec('echo line C >> file && git add file && git commit -m "Third commit"');
    sh.exec('echo line D >> file && git add file && git commit -m "Fourth commit"');
    const changelog = await gitClient.getChangelog('git log --pretty=format:"* %s (%h)" [REV_RANGE]');
    t.ok(/^\* Fourth commit \(\w{7}\)\n\* Third commit \(\w{7}\)$/.test(changelog));
  }

  sh.popd('-q');
  sh.rm('-rf', tmp);
  t.end();
});

test('getChangelog (custom)', async t => {
  const changelog = await gitClient.getChangelog('echo ${name}');
  t.equal(changelog, 'release-it');
  t.end();
});

test('isSameRepo', async t => {
  const gitClient = new Git();
  await gitClient.init();
  const otherClient = new Git();
  await otherClient.init();
  t.ok(gitClient.isSameRepo(otherClient));
  {
    sh.exec(`git init --bare ${tmpBare}`);
    sh.exec(`git clone ${tmpBare} ${tmp}`);
    sh.mkdir(tmp);
    sh.pushd('-q', tmp);
    const otherClient = new Git();
    await otherClient.init();
    t.notOk(gitClient.isSameRepo(otherClient));
  }
  sh.popd('-q');
  sh.rm('-rf', [tmpBare, tmp]);
  t.end();
});
