const { ApiPromise, WsProvider, ApiRx } = require('@polkadot/api');
const { DerivedSessionInfo } = require('@polkadot/api-derive/types');
const { formatNumber } = require('@polkadot/util');
const Sentry = require('@sentry/node');
const express = require('express');
var yargs = require('yargs');
const prom = require('./promClient');


//Arguments we pass to our script
var argv = yargs.usage('Kusama imOnline Monitoring')
  .options({
    'node': {
      description: 'Provide a websocket to query data from (e.g. wss://kusama-rpc.polkadot.io/)',
      required: true,
      alias: 'ws',
    },
    'validator': {
      description: 'Provide a validator to be monitored, flag can be used multiple times to monitor multiple validators',
      type: 'array',
      required: true,
      alias: 'val',
    },
    'dsn': {
      description: 'Provide a Sentry.io DSN to send alerts to. If not provided, no alerts will be triggered.',
      type: 'string',
      required: false,
      alias: 'sentry',
    },
    'port': {
      description: 'Prometheus exporter port',
      type: 'interger',
      required: false,
      default: 5555,
    }
  }).argv;

//Getting validators to watch out for from arguments
const vals = argv.validator
//Setting up the websocket
const provider = new WsProvider(argv.node);

const app = express();
const port = argv.port;

/// Polkadot API Endpoint
const LocalEndpoint = argv.node;

//Blocks Per Session (KUSAMA)
const bps = 2400;
//initialize correct sentry dsn to alert to
//Format: https://*****************@sentry.io/*******
const sentry = argv.dsn
if (sentry != undefined) {
  console.log("Initializing Sentry alert at url", sentry)
  Sentry.init({ dsn: sentry });
}

async function main () {
  // Create the API and wait until ready
  const api = await ApiPromise.create({
    provider: provider
    });
  
    api.on('error', () => {
      console.log('===========Error happened');
    });
    api.on('disconnected', () => {
      console.log('===========WS api disconnected, try to restart');
      process.exit();
    });

    prom.injectMetricsRoute(app);
    prom.startCollection();
    app.listen(port, () => console.log(`imOnline monitor running at ${argv.node}`));

  // Retrieve the chain & node information information via rpc calls
  const [chain, nodeName, nodeVersion] = await Promise.all([
    api.rpc.system.chain(),
    api.rpc.system.name(),
    api.rpc.system.version()
  ]);
  //Indicates if we are connected to the correct chain
  console.log(`You are connected to chain ${chain} using ${nodeName} v${nodeVersion}`);
  //validators in the current session
  let validators;
  //indices of validators we are monitoring
  let authIndices;
  //Block Number we last send an alert
  let lastWarn = 0;
  //Last index we alerted on
  let lastIndex = 0;
  // Last era index 
  let lastEraIndex = 0;
  //subscribing to new heads of the chain
  const unsubscribe = await api.rpc.chain.subscribeNewHeads(async (header) => {
    console.log(`Chain is at block: #${header.number} hash: #${header.hash}`);
    let progress = await getCurrentSessionProgress(api)
    let session = await getSession(api, header.number)
    /**
    validators in the current session
    we requery this & authIndices everytime since they can change over time
    we could query less (e.g when a new session / era starts), but this is much simpler
    **/

    let validators = await api.query.session.validators();
    //indices of validators we are monitoring
    let authIndices = await getIndices(api,vals,validators);
    for (const [_, authIndex] of authIndices.entries()) {
        console.log(`Checking AuthIndex #${authIndex}, Session #${session}, Progress ${Math.round(progress * 100)}%`);

        let activeEra = await api.query.staking.activeEra();
        activeEra = JSON.parse(JSON.stringify(activeEra));
        const currentEraIndex = activeEra.index;
  
        console.log(`activeEva is ${currentEraIndex}`);
  
        let [currentEraPointsEarned] = await Promise.all([
          api.query.staking.erasRewardPoints(currentEraIndex)
        ]);
        const rewardPoints = currentEraPointsEarned.get('individual').toJSON();
        const r = rewardPoints[vals];
        console.log(`current rewards point is ${r}`);
  
        if (r) {
          prom.reward_point.set({ validator: validators[authIndex].toString(), chain: chain, name: nodeName, version: nodeVersion }, r);
        } else {
  
          prom.reward_point.set({ validator: validators[authIndex].toString(), chain: chain, name: nodeName, version: nodeVersion }, 0);
        }
  
        if (currentEraIndex > lastEraIndex) {
          lastEraIndex = currentEraIndex
          prom.current_index.set({ validator: validators[authIndex].toString(), chain: chain, name: nodeName, version: nodeVersion }, lastEraIndex);
       
          //last era rewards
          let last_rewards = await get_rewards(api, vals, currentEraIndex-1,currentEraIndex);
          console.log(`last Era rewards is ${last_rewards}`);
          prom.last_era_rewards.set({ chain: chain, name: nodeName, version: nodeVersion }, last_rewards);

          //24hours rewards for kusama
          if (chain == 'Kusama'){
            let daily_rewards = await get_rewards(api, vals, currentEraIndex-4,currentEraIndex);
            console.log(`24 hours rewards is ${daily_rewards}`);
            prom.daily_rewards.set({ chain: chain, name: nodeName, version: nodeVersion }, daily_rewards);
          }
          //21 day(84 era) rewards
          let all_rewards = await get_rewards(api, vals, currentEraIndex-84,currentEraIndex);
          console.log(`84 Eras rewards is ${all_rewards}`);
          prom.all_rewards.set({ chain: chain, name: nodeName, version: nodeVersion }, all_rewards);

        }
        
        
        let heartbeat = await getHeartbeat(api, session, authIndex)
        //Heartbeat is "0x00" if no heartbeat message was received yet
        if(heartbeat.toString() == "0x00") {
          /**
          this is here to prevent constant alerting, maximum alert for one validator every 10% of a session (should be max every ~24 minutes)
          authIndex > lastIndex because we want to be able to alert for different validators at the same time
          indices are sorted, so every validator can only trigger this once per 10% of session
          **/
          if (header.number > lastWarn + (0.1 * bps) || authIndex > lastIndex) {
            //So that we are not reporting at the start of a new session
            if(Math.round(progress * 100) > 0) {
              sendAlert(validators[authIndex],session)
              lastWarn = header.number.toNumber()
              lastIndex = authIndex
              prom.imOnline_failure.set({validator: validators[authIndex].toString(), chain: chain, name: nodeName, version: nodeVersion }, 1);
            }
          } else {
            //Sending no new alert, but still putting it to the logs / cli
            console.log(validators[authIndex].toString(), "has not submitted a heartbeat this session[",Math.round(progress * 100),"%].")
            prom.imOnline_failure.set({validator: validators[authIndex].toString(), chain: chain, name: nodeName, version: nodeVersion }, 1);
          }
        } else {
          //Indicates that validator has sent a heartbeat this session -> is working properly
          console.log("Everything good -",validators[authIndex].toString()," sent a heartbeat.")
          prom.imOnline_failure.set({validator: validators[authIndex].toString(), chain: chain, name: nodeName, version: nodeVersion }, 0);
        }
      }
  });

}

//check if validator at $authIndex has submitted a heartbeat this session
async function getHeartbeat(api, session, authIndex) {
  let heartbeat = await api.query.imOnline.receivedHeartbeats(session, authIndex)
  return heartbeat
}

//get the current session index we are in
async function getSession(api) {
  let session = await api.query.session.currentIndex()
  return session
}

//Query Progress in current session
async function getCurrentSessionProgress(api){
  let DerivedSession = await api.derive.session.info();
  return DerivedSession.sessionProgress / bps
}

//gets indices of validators we are monitoring in the current validator set
//authIndex is required to query heartbeats
async function getIndices(api, vals, validators) {
  let authIndices = [];
  for (const [index, validator] of validators.entries()){
    if (vals.includes(validator.toString())) {
      authIndices.push(index)
      console.log(index, validator.toString());
    }
  }
  return authIndices
}

//Send an alert in case heartbeat has not been sent
async function sendAlert(val, session, heartbeat) {
  console.log("#####")
  console.log("Reporting",val.toString(),"for session" ,formatNumber(session))
  console.log("#####")

  prom.imOnline_failure.set({validator: validators[authIndex].toString(), chain: chain, name: nodeName, version: nodeVersion }, 1);
  if (sentry != undefined) {
    Sentry.captureMessage(val.toString() +  "is reported offline");
  }
}

// rewards
async function get_rewards (api, vals, beginIndex, endIndex) {
  let t=0;
  for (var i=beginIndex;i<endIndex;i++ ){
    const rewards = await api.query.staking.erasValidatorReward(i);
    const total_rewards = rewards.toJSON();
    if (total_rewards === null){
      continue;
    }
    //console.log(total_rewards);

    let [currentEraPointsEarned] = await Promise.all([
          api.query.staking.erasRewardPoints(i)
        ]);
    const total_points = currentEraPointsEarned.get('total').toJSON();
    if (total_points === 0){
      continue;
    }
    //console.log(total_points);

    const rewardPoints = currentEraPointsEarned.get('individual').toJSON();
    const r = rewardPoints[vals];
    if (r === undefined){
      continue;
    }
    //console.log(r);

    //const val_rewards = (total_rewards/total_points*r)*10**-12
    const val_rewards = total_rewards/total_points*r
    console.log(`valadator rewards in era ${i} is ${val_rewards}`)
    t=t+val_rewards;
    console.log(`total rewards to era ${i} is ${t}`)
  }
  return t;
}

main()
