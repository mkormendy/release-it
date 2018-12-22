const { EOL } = require('os');
const Logger = require('./log');
const Config = require('./config');
const Shell = require('./shell');
const Git = require('./git');
const GitHub = require('./github-client');
const npm = require('./npm');
const Version = require('./version');
const semver = require('semver');
const prompt = require('./prompt');
const Spinner = require('./spinner');
const { truncateLines } = require('./util');
const { debug, debugConfig } = require('./debug');
const handleDeprecated = require('./deprecated');
const { trackEvent, trackException } = require('./metrics');

module.exports = async opts => {
  const config = new Config(opts);

  const { isInteractive, isVerbose, isDryRun } = config;
  const log = new Logger({ isInteractive, isVerbose, isDryRun });

  try {
    const options = handleDeprecated(config.getOptions());

    debugConfig('%O', options);

    config.isCollectMetrics && trackEvent('start', options);

    const { dist, pkgFiles, scripts } = options;

    const shell = new Shell({ isVerbose, isDryRun, log, config });

    const sharedOptions = { isInteractive, isVerbose, isDryRun, log, shell };

    const s = new Spinner(sharedOptions);
    const gitClient = new Git(options.git, sharedOptions);
    const gitDistClient = new Git(options.git, dist.git, sharedOptions);
    let changelog;

    await gitClient.init();
    await gitClient.validate();

    // TODO: fix up stage dir validation for dist repo
    gitDistClient.validateStageDir(dist.stageDir);

    const remoteUrl = gitClient.remoteUrl;
    const run = shell.runTemplateCommand.bind(shell);

    const ghClient = new GitHub(options.github, options.git, sharedOptions, { remoteUrl });
    const ghDistClient = new GitHub(options.github, dist.github, options.git, dist.git, sharedOptions, { remoteUrl });

    const npmClient = new npm(options.npm, sharedOptions);
    const npmDistClient = new npm(options.npm, dist.npm, sharedOptions);

    ghClient.validate();
    ghDistClient.validate();

    const getChangelog = async () => {
      const changelog = await gitClient.getChangelog(scripts.changelog);
      if (changelog) {
        log.info(`Changelog:${EOL}${truncateLines(changelog)}${EOL}`);
      } else {
        log.warn(`Empty changelog`);
      }
      return changelog;
    };

    await s.show(scripts.beforeStart, () => run(scripts.beforeStart), scripts.beforeStart);

    // TODO: handle latest git tag vs. npm version
    const useTag = Boolean(gitClient.isRootDir && semver.valid(gitClient.latestTag));
    const latestVersion = useTag ? gitClient.latestTag : options.npm.version;
    const v = new Version({ latestVersion, preReleaseId: options.preReleaseId, log });

    // TODO: handle latest git tag vs. npm version
    v.showWarnings({ latestGitTag: gitClient.latestTag, npmVersion: options.npm.version, useTag });
    await v.bump({ increment: options.increment, preRelease: options.preRelease });
    config.setRuntimeOptions(v.details);

    const suffix = v.version ? `${latestVersion}...${v.version}` : `currently at ${latestVersion}`;
    log.log(`${EOL}🚀 Let's release ${options.name} (${suffix})${EOL}`);

    // TODO: don't use class-in-class
    const isLateChangeLog = v.recs.isRecommendation(options.increment);
    if (!isLateChangeLog) {
      changelog = await getChangelog();
      config.setRuntimeOptions({ changelog });
    }

    if (isInteractive && !v.version) {
      const context = config.getOptions();
      await prompt(true, context, 'incrementList', async increment => {
        if (increment) {
          await v.bump({ increment });
        } else {
          await prompt(true, context, 'version', async version => {
            v.version = version;
          });
        }
      });
    }

    v.validate();
    config.setRuntimeOptions(v.details);
    const { version, isPreRelease } = v.details;

    if (isInteractive && pkgFiles && options.git.requireCleanWorkingDir) {
      process.on('SIGINT', () => gitClient.reset(pkgFiles));
      process.on('exit', () => gitClient.reset(pkgFiles));
    }

    await s.show(scripts.beforeBump, () => run(scripts.beforeBump), scripts.beforeBump);
    await s.show(true, () => shell.bump(pkgFiles, version), 'Bump version');
    await s.show(scripts.afterBump, () => run(scripts.afterBump), scripts.afterBump);

    if (isLateChangeLog) {
      changelog = await getChangelog();
      config.setRuntimeOptions({ changelog });
    }

    await s.show(scripts.beforeStage, () => run(scripts.beforeStage), scripts.beforeStage);
    await gitClient.stage(pkgFiles);
    await gitClient.stageDir();

    const changeSet = await gitClient.status();
    if (changeSet) {
      log.info(`Changeset:${EOL}${truncateLines(changeSet)}${EOL}`);
    } else {
      log.warn(`Empty changeset`);
    }

    if (options.dist.repo) {
      const { pkgFiles, scripts } = options.dist;
      await s.show(true, () => gitDistClient.clone(options.dist.repo, options.dist.stageDir), 'Clone');
      await shell.copy(options.dist.files, { cwd: options.dist.baseDir }, options.dist.stageDir);
      await shell.pushd(options.dist.stageDir);
      await shell.bump(pkgFiles, version);
      await s.show(scripts.beforeStage, () => run(scripts.beforeStage), scripts.beforeStage);
      await gitDistClient.stageDir();
      await shell.popd();
    }

    const release = async ({ options, gitClient, ghClient, npmClient }) => {
      const context = Object.assign(config.getOptions(), options);
      const { git, github, npm } = options;

      const commit = () => gitClient.commit();
      const tag = () => gitClient.tag();
      const push = () => gitClient.push();
      const release = () => ghClient.release({ version, isPreRelease, changelog });
      const uploadAssets = () => ghClient.uploadAssets();
      const releaseAndUploadAssets = async () => (await release()) && (await uploadAssets());
      const otpPrompt = task => prompt(true, context, 'otp', task);
      const publish = () => npmClient.publish({ version, isPreRelease, otpPrompt });

      if (!isInteractive) {
        await s.show(git.commit, commit, 'Git commit');
        await s.show(git.tag, tag, 'Git tag');
        await s.show(git.push, push, 'Git push');
        await s.show(github.release, release, 'GitHub release');
        await s.show(github.assets, uploadAssets, 'GitHub upload assets');
        await s.show(npm.publish && !npm.private, publish, 'npm publish');
      } else {
        await prompt(git.commit, context, 'commit', commit);
        await prompt(git.tag, context, 'tag', tag);
        await prompt(git.push, context, 'push', push);
        await prompt(github.release, context, 'release', releaseAndUploadAssets);
        await prompt(npm.publish && !npm.private, context, 'publish', publish);
      }

      await s.show(scripts.afterRelease, () => run(scripts.afterRelease), scripts.afterRelease);
    };

    await release({ options, gitClient, ghClient, npmClient });

    if (options.dist.repo) {
      log.log(`${EOL}🚀 Let's release the distribution repo for ${options.name}${EOL}`);

      await shell.pushd(options.dist.stageDir);

      // TODO: fix up `shouldTag`
      await gitDistClient.init();
      options.dist.git.tag = gitDistClient.shouldTag(gitClient);

      if (!isInteractive) {
        await gitDistClient.status();
      } else {
        log.info(`Changeset:${EOL}${await gitDistClient.status()}${EOL}`);
      }

      await release({
        options: options.dist,
        gitClient: gitDistClient,
        ghClient: ghDistClient,
        npmClient: npmDistClient
      });

      await shell.popd();
      await run(`!rm -rf ${options.dist.stageDir}`);
    }

    ghClient.isReleased && log.log(`🔗 ${ghClient.getReleaseUrl()}`);
    ghDistClient.isReleased && log.log(`🔗 ${ghDistClient.getReleaseUrl()}`);
    npmClient.isPublished && log.log(`🔗 ${npmClient.getPackageUrl()}`);
    npmDistClient.isPublished && log.log(`🔗 ${npmDistClient.getPackageUrl()}`);

    config.isCollectMetrics && trackEvent('end');

    log.log(`🏁 Done (in ${Math.floor(process.uptime())}s.)`);

    return Promise.resolve({
      changelog,
      latestVersion,
      version
    });
  } catch (err) {
    config.isCollectMetrics && trackException(err);
    log.error(err.message || err);
    debug(err);
    throw err;
  }
};
