import JWT from 'jsonwebtoken';
import secret from 'secret-key';
import {v1 as uuidV1} from 'uuid';
import express from 'express';
import http from 'http';
import socket from 'socket.io';
import bodyparser from 'body-parser';
import axios from 'axios';
import cors from 'cors';
import * as fs from "fs";
import {EventEmitter} from "events";

const APP = express();
APP.use(bodyparser.json());
APP.use(cors());
const server = http.createServer(APP);
const io = socket(server);
const PORT = process.env.PORT || 9898;


const getSecret = () => {
    if (!fs.existsSync('./.secret')) {
        const s = secret.create(uuidV1()).secret;
        fs.writeFileSync('./.secret', s);
        return s;
    } else {
        return fs.readFileSync('./.secret');
    }
}

const SECRET_KEY = getSecret();

class Player {
    id: string;
    score: number;
    name: string;
}

class Audience {
    id: string;
}

class Card {
    url: string;
    user: Player;
    votes: number;
    audienceVotes: number;
}

class GameData {
    id: string;
    name: string;
    code: string;
    password: string;
    players: Array<Player>;
    audience: Array<Audience>;
    card1: Card;
    card2: Card;
}

class TokenData {
    gameId: string;
    admin: boolean;
    player: boolean;
    iat: number;
    nickname: string;
}

class AccessToken {
    gameId: string;
    userId: string;
    admin: boolean;
    player: boolean;
    iat: number;
}

enum GameEvents {
    UpdateUsers,
    Duel,
    DeleteGame,
}

class GameEventEmitter extends EventEmitter {
}

const GameEmitters: Map<string, GameEventEmitter> = new Map<string, GameEventEmitter>();

const newUUID = () => {
    return uuidV1();
};

const newCode = () => {
    let ALL = "abcdefghkmnpqrstuvwxyz123456789".toUpperCase();
    let s = "";
    for (let i = 0; i < 4; i++) {
        s += ALL[Math.floor(Math.random() * ALL.length)];
    }
    return s;
}

const newToken = (payload: any) => {
    return JWT.sign(payload, SECRET_KEY);
};

const verifyToken = <T>(token: any): T => {
    return JWT.verify(token, SECRET_KEY) as any as T;
};

// "database"
const gd: Map<string, GameData> = new Map<string, GameData>();
const codeMap: Map<string, string> = new Map<string, string>();

APP.get('/', (req, res) => {
    return res.json(gd);
});

APP.post('/spectate', (req, res) => {
    const gameId = codeMap.get(req.body.code.toUpperCase());
    const token = newToken({gameId, admin: false, player: false});
    return res.json({token});
});

APP.post('/join', (req, res) => {
    const gameId = codeMap.get(req.body.code.toUpperCase());
    const game = gd.get(gameId);
    if (game) {
        if (req.body.password === game.password) {
            const token = newToken({gameId, nickname: req.body.nickname, admin: false, player: true});
            return res.json({token});
        } else {
            return res.json({error: 'invalid password'});
        }
    } else {
        return res.json({error: 'invalid code'});
    }
});

APP.post('/new', (req, res) => {
    const game = new GameData();
    game.id = newUUID();
    game.code = newCode();
    game.audience = new Array<Audience>();
    game.players = new Array<Player>();
    game.name = req.body.name;
    game.password = req.body.password;
    gd.set(game.id, game);
    codeMap.set(game.code, game.id);
    GameEmitters.set(game.id, new GameEventEmitter());
    GameEmitters.get(game.id).setMaxListeners(100000);
    const token = newToken({gameId: game.id, nickname: req.body.nickname, admin: true, player: true});
    return res.json({token});
});

APP.post('/mate', (req, res) => {
    const tokenData = verifyToken<TokenData>(req.body.token);
    if (gd.get(tokenData.gameId)) {
        const userId = uuidV1();
        const t: AccessToken = new AccessToken();
        t.admin = tokenData.admin;
        t.userId = userId;
        t.gameId = tokenData.gameId;
        t.player = tokenData.player;
        if (tokenData.player) {
            const p = new Player();
            p.id = userId;
            p.score = 0;
            p.name = tokenData.nickname
            gd.get(tokenData.gameId).players.push(p);
        } else {
            const a = new Audience();
            a.id = userId;
            gd.get(tokenData.gameId).audience.push(a);
        }
        const token = newToken({
            admin: t.admin,
            gameId: t.gameId,
            player: t.player,
            userId: t.userId
        });
        GameEmitters.get(tokenData.gameId).emit(GameEvents.UpdateUsers.toString())
        return res.json({token});
    } else {
        return res.json({error: 'game doesn\'t exist'})
    }
});

const duel = async (gameId) => {
    const RANDOM_CARD_URL = 'https://db.ygoprodeck.com/api/v7/randomcard.php';
    const res1 = await axios.get(RANDOM_CARD_URL);
    const res2 = await axios.get(RANDOM_CARD_URL);
    const players = [...gd.get(gameId).players];
    const r1 = Math.floor(Math.random() * players.length);
    const user1 = players.splice(r1, 1)[0];
    const r2 = Math.floor(Math.random() * players.length);
    const user2 = players.splice(r2, 1)[0];
    const card1: Card = {
        url: res1.data.card_images[0].image_url,
        user: user1,
        audienceVotes: 0,
        votes: 0
    };
    const card2: Card = {
        url: res2.data.card_images[0].image_url,
        user: user2,
        audienceVotes: 0,
        votes: 0
    };
    gd.get(gameId).card1 = card1;
    gd.get(gameId).card2 = card2;
    return {card1, card2};
};

io.on('connection', (socket) => {
    console.log(socket.id);
    socket.on('bind-events', (data) => {
        try {
            const tokenData = verifyToken<AccessToken>(data.token);
            const ee = GameEmitters.get(tokenData.gameId);
            ee.on(GameEvents.UpdateUsers.toString(), () => {
                socket.emit('users', gd.get(tokenData.gameId).players);
            });
            ee.on(GameEvents.Duel.toString(), () => {
                socket.emit('duel', {
                    card1: gd.get(tokenData.gameId).card1,
                    card2: gd.get(tokenData.gameId).card2,
                });
            });
            ee.on(GameEvents.DeleteGame.toString(), () => {
                socket.emit('leave');
            });
        } catch (e) {
            console.error(e);
            socket.emit('leave');
        }
    });
    socket.on('admin-check', (data) => {
        try {
            const tokenData = verifyToken<AccessToken>(data.token);
            socket.emit('admin', tokenData.admin);
        } catch (e) {
            console.error(e);
            socket.emit('leave');
        }
    });
    socket.on('get-code', (data) => {
        try {
            const tokenData = verifyToken<AccessToken>(data.token);
            socket.emit('code', gd.get(tokenData.gameId).code);
        } catch (e) {
            console.error(e);
            socket.emit('leave');
        }
    });
    socket.on('get-users', (data) => {
        try {
            const tokenData = verifyToken<AccessToken>(data.token);
            socket.emit('users', gd.get(tokenData.gameId).players);
        } catch (e) {
            console.error(e);
            socket.emit('leave');
        }
    });
    socket.on('vote', (data) => {
        try {
            const tokenData = verifyToken<AccessToken>(data.token);
            if (tokenData.player) {
                if (data.number === 1) {
                    gd.get(tokenData.gameId).card1.votes++;
                } else {
                    gd.get(tokenData.gameId).card2.votes++;
                }
            } else {
                if (data.number === 1) {
                    gd.get(tokenData.gameId).card1.audienceVotes++;
                } else {
                    gd.get(tokenData.gameId).card2.audienceVotes++;
                }
            }
        } catch (e) {
            console.error(e);
            socket.emit('leave');
        }
    });
    socket.on('d-d-d-duel', async (data) => {
        try {
            const tokenData = verifyToken<AccessToken>(data.token);
            await duel(tokenData.gameId);
            GameEmitters.get(tokenData.gameId).emit(GameEvents.Duel.toString());
        } catch (e) {
            console.error(e);
            socket.emit('leave');
        }
    });
    socket.on('leaving', (data) => {
        try {
            const tokenData = verifyToken<AccessToken>(data.token);
            if (tokenData.admin) {
                gd.delete(tokenData.gameId);
                GameEmitters.get(tokenData.gameId).emit(GameEvents.DeleteGame.toString());
            } else {
                gd.get(tokenData.gameId).players = gd.get(tokenData.gameId).players.filter(e => e.id !== tokenData.userId);
                GameEmitters.get(tokenData.gameId).emit(GameEvents.UpdateUsers.toString());
            }
        } catch (e) {
            console.error(e);
            socket.emit('leave');
        }
    });
});

server.listen(PORT, () => {
    console.log(`server listening on ${PORT}`)
});
