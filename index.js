const admin = require('firebase-admin');

// Server modules
const WebSocket = require('ws');
const fs = require('fs');
const { join, extname } = require('path');
const https = require('https');
const mime = require('mime-types');

process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason.stack);
    // application specific logging, throwing an error, or other logic here
});

const tryParseJSON = require('./tryParseJson');

const ping = require('./fragments/ping');
const send = require('./fragments/send');

const pubKeys = {};
const signKeys = {};

// Constants
const debug = process.env['mode'] && process.env['mode'] === 'debug';

// Utility functions
function removeElem(arr, value) {
    var index = arr.indexOf(value);
    if (index > -1) {
        arr.splice(index, 1);
    }
    return arr;
}

let errorFile = '<h1>Reload this page</h1><p>We are experiencing some issues right now</p>';
fs.readFile('404.html', 'utf-8', (e, d) => {
    if (e) errorFile = '<h1>404</h1>';
    else errorFile = d;
});

const reqHandler = (req, res) => {
    console.log('Responding to HTTP request at', req.url);
    // Send the hello world file from the filesystem
    const url = req.url === '/' ? 'index.html' : req.url;
    fs.readFile(join('/home/chatty/chatty2-0', url), (e, d) => {
        const mimeType = (mime.contentType(extname(url)) || 'application/octet-stream') + '; charset=UTF-8';
        console.log('Content type:', mimeType);
        res.setHeader('Content-Type', mimeType);
        res.writeHead(e ? 404 : 200);
        if (e) res.end(errorFile);
        else res.end(d);
        res.end();
    });
}

// Init WebSocket
let wss, server;
if (debug) wss = new WebSocket.Server({ port: 8080 });
else {
    server = https.createServer({
        cert: fs.readFileSync('/etc/letsencrypt/live/' + (process.env['DOMAIN'] || 'api.chattyapp.cf') + '/fullchain.pem'),
        key: fs.readFileSync('/etc/letsencrypt/live/' + (process.env['DOMAIN'] || 'api.chattyapp.cf') + '/privkey.pem')
    }, reqHandler);
    wss = new WebSocket.Server({ server });
}

// Init Firebase admin
try {
    admin.initializeApp({
        credential: admin.credential.cert(process.env),
    });
} catch {
    admin.initializeApp({
        credential: admin.credential.applicationDefault(),
    });
}

const db = admin.firestore();

let onlineUIDs = [];
let wsObjs = {};
let bannedIP = [];
let bannedUID = [];

admin.firestore().collection("users").doc("banned").get().then(queryResult =>{
    bannedIP = queryResult.data().ip;
    bannedUID = queryResult.data().uid;
});

console.log('Ready to accept WebSocket connections');
// Handle WebSocket events
wss.on('connection', (ws, req) => {
    let first = true;
    let uid = null;
    let errAttempts = 10;

    setInterval(() => errAttempts++, 10000); // You get one "life" every 10s

    if (bannedIP.includes(req.headers['x-forwarded-for'] || req.connection.remoteAddress)) {
        ws.close();
        return;
    }

    setTimeout(() => {
        if (first && !uid) {
            ws.close();
            console.log('Closed client websocket');
        }
    }, 500); // 500ms for client to identify itself

    ws.send('hi');

    const close = () => {
        if (uid) onlineUIDs = removeElem(onlineUIDs, uid);
        delete wsObjs[uid];
        console.log(onlineUIDs);
    }

    ws.on('close', () => {
        console.log('Client ws closed');
        close();
    });

    ws.on('message', async d => {
        console.log('Received message:', d);
        if (first) {
            const info = tryParseJSON(d);
            first = false;

            if (!info || !info.uid || bannedUID.includes(info.uid)) {
                close();
                ws.close();
                return;
            }
            if (onlineUIDs.includes(info.uid)) {
                onlineUIDs[info.uid].send(JSON.stringify({err: 'anotherOnline'}));
                onlineUIDs[info.uid].close();
            }

            onlineUIDs.push(info.uid);
            uid = info.uid;
            wsObjs[uid] = ws;
            const snap = await db.collection('chats').doc('offline').collection(uid).get();
            snap.forEach(async doc => {
                console.log(doc.id, '=>', );
                const d = doc.data()
                await ws.send(JSON.stringify({
                    data: d.msg,
                    iv: d.iv,
                    gid: d.gid,
                    target: uid,
                    resp: 'txtMsg',
                    key: d.key,
                    uid: d.uid,
                    sig: d.sig,
                    purpose: d.purpose,
                    time: d.time,
                }));
                await db.collection('chats').doc('offline').collection(uid).doc(doc.id).delete();
                // await doc.delete();
            });
            await ws.send('connected');
            return;
        }

        const p = tryParseJSON(d);
        if (!p || !p.act || typeof p.act !== 'string') {
            errAttempts--;
            if (errAttempts <= 0) ws.close();
            await ws.send(JSON.stringify({
                err: 'invalid',
                lives: errAttempts
            }));
            return;
        }

        switch (p.act) {
            case 'ping':
                await ws.send(JSON.stringify({
                    resp: 'pong',
                    servTime: +new Date()
                }));
                break;
            case 'sendTxt':
                if (onlineUIDs.includes(p.id)) {
                    await wsObjs[p.id].send(JSON.stringify({
                        data: p.data,
                        iv: p.iv,
                        gid: p.gid,
                        target: p.id,
                        resp: 'txtMsg',
                        key: p.key,
                        uid: uid,
                        sig: p.sig,
                        purpose: p.purpose,
                        time: +new Date(),
                    }));
                    return;
                } else {
                    // The user is offline
                    db.collection('chats').doc('offline').collection(p.id).doc((+new Date()).toString()).set({
                        msg: p.data,
                        iv: p.iv,
                        gid: p.gid,
                        key: p.key,
                        uid: uid,
                        sig: p.sig,
                        purpose: p.purpose,
                        time: +new Date(),
                    });
                }
                break;
            case 'updatePub':
                pubKeys[uid] = p.key;
                console.log(pubKeys);
                break;
            case 'updateSign':
                signKeys[uid] = p.key;
                console.log(uid);
                console.log(signKeys);
            case 'getPub':
                await ws.send(JSON.stringify({
                    pub: pubKeys[p.uid],
                    resp: 'pubKey',
                    uid: p.uid,
                }));
                break;
            case 'getSignPub':
                await ws.send(JSON.stringify({
                    pub: signKeys[p.target],
                    resp: 'signKey',
                    uid: p.target,
                }));
        }
    })
});

if (!debug) server.listen(443);
