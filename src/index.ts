import { Line, spotify } from "~spotify";
require('dotenv').config();

const client = new spotify(process.env.CLIENTID, process.env.CLIENTSECRET, process.env.cookie)
client.update()
client.event.on('lyricUpdate', (newLine: Line, Lines: Array<Line>) => {
    console.log(newLine.text)
})