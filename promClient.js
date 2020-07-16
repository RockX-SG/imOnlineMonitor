const promClient = require('prom-client');
const { register } = promClient;

const startCollection = () => {
  console.log('Starting the collection of metrics, the metrics are available on /metrics');
  promClient.collectDefaultMetrics();
}

const injectMetricsRoute = (app) => {
  app.get('/metrics', (_, res) => {
    res.set('Content-Type', register.contentType);
    res.end(register.metrics());
  });
}

const imOnline_failure = new promClient.Gauge({
  name: 'polkadot_imOnline_failure',
  help: 'Check imoOnline status',
  labelNames: ['validator', 'chain', 'name', 'version'],
});

const reward_point = new promClient.Gauge({
  name: 'polkadot_reward_point',
  help: 'Check current reward point',
  labelNames: ['validator', 'chain', 'name', 'version'],
});

const current_index = new promClient.Gauge({
  name: 'polkadot_current_index',
  help: 'Check current era index',
  labelNames: ['validator', 'chain', 'name', 'version'],
});

module.exports = {
  startCollection,
  injectMetricsRoute,
  imOnline_failure,
  reward_point,
  current_index,
};