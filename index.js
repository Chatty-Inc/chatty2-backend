const admin = require('firebase-admin');

const WebSocket = require('ws');

process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason.stack);
    // application specific logging, throwing an error, or other logic here
});

const tryParseJSON = require('./tryParseJson');

const ping = require('./fragments/ping');
const send = require('./fragments/send');

const pubKeys = {};
const signKeys = {};

// Utility functions
function removeElem(arr, value) {
    var index = arr.indexOf(value);
    if (index > -1) {
        arr.splice(index, 1);
    }
    return arr;
}

// Init WebSocket
const wss = new WebSocket.Server({
    port: 4000,
    perMessageDeflate: {
        zlibDeflateOptions: {
            // See zlib defaults.
            chunkSize: 1024,
            memLevel: 7,
            level: 3
        },
        zlibInflateOptions: {
            chunkSize: 10 * 1024
        },
        // Other options settable:
        clientNoContextTakeover: true, // Defaults to negotiated value.
        serverNoContextTakeover: true, // Defaults to negotiated value.
        serverMaxWindowBits: 10, // Defaults to negotiated value.
        // Below options specified as default values.
        concurrencyLimit: 10, // Limits zlib concurrency for perf.
        threshold: 1024 // Size (in bytes) below which messages
        // should not be compressed.
    }
});
// Init Firebase admin
admin.initializeApp({
    credential: admin.credential.cert(process.env),
});
const db = admin.firestore();

let onlineUIDs = [];
let wsObjs = {};
let bannedIP = [];
let bannedUID = [];

admin.firestore().collection("users").doc("banned").get().then(queryResult =>{
    bannedIP = queryResult.data().ip;
    bannedUID = queryResult.data().uid;
});

// Handle WebSocket events
wss.on('connection', (ws, req) => {
    let first = true;
    let uid = null;
    let errAttempts = 10;

    setInterval(() => errAttempts++, 10000); // You get one "life" every 10s

    setTimeout(() => {
        if (first && !uid) {
            ws.close();
            console.log('Closed client websocket');
        }
        console.log(uid)
        console.log("ayo2")
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
            if (!info || !info.uid || onlineUIDs.includes(info.uid)) {
                close();
                ws.close();
                return;
            }
            if (bannedIP.includes(req.headers['x-forwarded-for'] || req.connection.remoteAddress)||bannedUID.includes(info.uid)) {
                ws.close();
                return;
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
                    sig: d.sig
                }));
                await db.collection('chats').doc('offline').collection(uid).doc(doc.id).delete();
                // await doc.delete();
            });
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
                        sig: p.sig
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
                        sig: p.sig
                    });
                    /*db.collection("users").where("messages", "==", "messages").limit(1).get().then(snapshot => {
                        if (snapshot.exists) {
                            console.log("Document does not exist, creating one now");
                            console.log("id: ", p.id);
                            db.collection('users').doc(p.id).set({
                                messages: [{
                                    data: p.data,
                                    iv: p.iv,
                                    gid: p.gid,
                                    target: p.id,
                                    resp: 'txtMsg',
                                    key: p.key,
                                    uid: uid,
                                    sig: p.sig
                                }]
                            });
                        }
                        else {
                            console.log("Document exists, appending");
                            db.collection('users').doc(p.id).update({
                                messages: admin.firestore.FieldValue.arrayUnion({
                                    data: p.data,
                                    iv: p.iv,
                                    gid: p.gid,
                                    target: p.id,
                                    resp: 'txtMsg',
                                    key: p.key,
                                    uid: uid,
                                    sig: p.sig
                                })
                            });
                        }
                    });*/
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