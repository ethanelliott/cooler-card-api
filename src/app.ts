import express from 'express';

const PORT = 9898;

const APP = express();

APP.get('/', async (req, res) => {
    console.log('test');
    return res.json({});
});

APP.listen(PORT, () => {
    console.log(`listening on ${PORT}`);
});