module.exports = async ws => {
    await ws.send(JSON.stringify({resp: 'pong', servTime: +new Date()}));
}