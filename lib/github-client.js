const fs = require('fs');
const path = require('path');
const GitHubApi = require('@octokit/rest');
const retry = require('async-retry');
const globby = require('globby');
const mime = require('mime-types');
const _ = require('lodash');
const repoPathParse = require('parse-repo');
const Log = require('./log');
const { format } = require('./util');
const { GithubTokenError, GithubClientError } = require('./errors');
const { debug } = require('./debug');
const { github: defaults } = require('../conf/release-it.json');

const noop = Promise.resolve();

const NO_RETRIES_NEEDED = [400, 401, 404, 422];

const parseErrorMessage = err => {
  let msg = err;
  try {
    if (err instanceof Error) {
      const { status, message } = err;
      msg = `${status} (${message.replace(/[\n\r]+/g, ' ')})`;
    }
  } catch (err) {
    debug(err);
  }
  return msg;
};

class GitHub {
  constructor(...args) {
    const options = Object.assign({}, ...args);
    this.options = _.defaults(options, defaults);
    this.repo = repoPathParse(options.remoteUrl);
    this.log = options.log || new Log();
  }

  validate() {
    if (!this.options.release) return;
    if (!this.token) {
      throw new GithubTokenError(this.options.tokenRef);
    }
  }

  get token() {
    const { tokenRef } = this.options;
    return _.get(process.env, tokenRef, null);
  }

  getGithubClient() {
    if (this.client) return this.client;
    const { proxy, timeout } = this.options;
    const host = this.options.host || this.repo.host;
    const isGitHub = host === 'github.com';
    const baseUrl = `https://${isGitHub ? 'api.github.com' : host}${isGitHub ? '' : '/api/v3'}`;
    const options = {
      version: '3.0.0',
      baseUrl,
      timeout,
      headers: {
        'user-agent': 'webpro/release-it'
      }
    };

    if (proxy) {
      options.proxy = proxy;
    }

    const client = new GitHubApi(options);

    client.authenticate({
      type: 'oauth',
      token: this.token
    });

    this.client = client;
    return client;
  }

  release({ version, isPreRelease, changelog = '' }) {
    this.log.exec('octokit releases#createRelease');

    if (this.options.isDryRun) {
      this.log.dry();
      return noop;
    }

    const client = this.getGithubClient();
    const { tagName, releaseName, draft } = this.options;
    const { owner, project: repo } = this.repo;

    return retry(
      async bail => {
        try {
          const response = await client.repos.createRelease({
            owner,
            repo,
            tag_name: format(tagName, { version }),
            name: format(releaseName, { version }),
            body: changelog,
            prerelease: isPreRelease,
            draft
          });
          const { name, tag_name, html_url, upload_url } = response.data;
          this.log.verbose(`octokit releases#createRelease: done (${response.headers.location} ${tag_name} "${name}")`);
          this.version = version;
          this.releaseUrl = html_url;
          this.uploadUrl = upload_url;
          this.isReleased = true;
          return response.data;
        } catch (err) {
          const msg = parseErrorMessage(err);
          const { status } = err;
          if (_.includes(NO_RETRIES_NEEDED, status)) {
            bail(new GithubClientError(msg));
            return;
          }
          this.log.warn(msg);
          throw err;
        }
      },
      {
        retries: 2
      }
    );
  }

  uploadAsset(filePath) {
    const client = this.getGithubClient();
    const url = this.uploadUrl;
    const name = path.basename(filePath);
    const contentType = mime.contentType(name) || 'application/octet-stream';
    const contentLength = fs.statSync(filePath).size;

    return retry(
      async bail => {
        try {
          const response = await client.repos.uploadReleaseAsset({
            url,
            file: fs.createReadStream(filePath),
            name,
            headers: {
              'content-type': contentType,
              'content-length': contentLength
            }
          });
          this.log.verbose(`octokit releases#uploadAsset: done (${response.data.browser_download_url})`);
          return response.data;
        } catch (err) {
          const msg = parseErrorMessage(err);
          const { status } = err;
          if (_.includes(NO_RETRIES_NEEDED, status)) {
            bail(new GithubClientError(msg));
            return;
          }
          this.log.warn(msg);
          throw err;
        }
      },
      {
        retries: 2
      }
    );
  }

  uploadAssets() {
    const { assets } = this.options;

    if (!assets) {
      return noop;
    }

    this.log.exec('octokit releases#uploadAssets');

    if (this.options.isDryRun) {
      this.log.dry();
      return noop;
    }

    return globby(assets).then(files => {
      if (!files.length) {
        this.log.warn(
          `octokit releases#uploadAssets: assets not found (glob "${assets}" relative to ${process.cwd()})`
        );
      }
      return Promise.all(files.map(filePath => this.uploadAsset(filePath)));
    });
  }

  getReleaseUrlFallback() {
    const tag = format(this.options.tagName, { version: this.version });
    const { host, repository } = this.repo;
    return `https://${host}/${repository}/releases/tag/${tag}`;
  }

  getReleaseUrl() {
    return this.releaseUrl || this.getReleaseUrlFallback();
  }
}

module.exports = GitHub;
