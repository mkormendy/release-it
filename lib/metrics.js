const { EOL } = require('os');
const got = require('got');
const supportsColor = require('supports-color');
const windowSize = require('window-size');
const uuid = require('uuid');
const osName = require('os-name');
const isCi = require('is-ci');
const _ = require('lodash');
const { debug } = require('./debug');
const pkg = require('../package.json');

const cast = value => (value ? 1 : 0);
const pickDebugProps = response => _.pick(response, ['statusCode', 'statusMessage', 'url']);

const cid = uuid.v4();
const dimensions = windowSize ? windowSize.get() : { width: 0, height: 0 };
const vp = `${dimensions.width}x${dimensions.height}`;
const depths = ['1-bit', '4-bit', '8-bit', '24-bits'];
const sd = depths[supportsColor.level || 0];

const payload = config => ({
  v: 1,
  tid: 'UA-108828841-1',
  cid,
  vp,
  sd,
  cd1: pkg.version,
  cd2: process.version,
  cd3: osName(),
  cd4: cast(config.isInteractive),
  cd5: cast(config.isDryRun),
  cd6: cast(config.isVerbose),
  cd7: cast(config.isDebug),
  cd8: cast(config.scripts.beforeStage),
  cd9: config.preReleaseId,
  cd10: cast(config.dist.repo),
  cd11: cast(isCi),
  cd12: cast(config.git.tag),
  cd13: cast(config.npm.publish),
  cd14: cast(config.github.release),
  cd15: config.increment
});

const send = payload =>
  got('http://www.google-analytics.com/collect', {
    timeout: 300,
    retries: 0,
    form: true,
    body: payload
  })
    .then(pickDebugProps)
    .then(debug)
    .catch(debug);

module.exports.trackEvent = (action, config) =>
  send(
    Object.assign(config ? payload(config) : {}, {
      t: 'event',
      ec: 'session',
      ea: action
    })
  );

module.exports.trackException = err =>
  send({
    t: 'exception',
    exd: err.message.split(EOL)[0]
  });
