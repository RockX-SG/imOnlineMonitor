# docker build -t polkadot-monitor .
# sudo docker run --log-driver=journald -d --name kusama_monitor --restart=always -p 5555:5555 polkadot-monitor --node 'wss://kusama-rpc.polkadot.io/' --validator 'EfK27sX89DpagD3TCF4hF4rGZ1CnCGtYZvo94HZLU3GQuMj'
FROM node:14

WORKDIR /imonline
COPY .  /imonline

RUN yarn install

EXPOSE  5555
ENTRYPOINT ["node", "index.js"]