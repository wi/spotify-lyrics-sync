import axios, {AxiosRequestConfig} from "axios";
import {EventEmitter} from "events"


interface PlaybackState {
    trackName?: string,
    trackId?: string,
    oldTrackId?: string,
    trackDuration: 0,
    trackProgress: 0,
    lyrics: Array<any>,
    currentLyrics: null,
    hasLyrics: false,
}

interface Client {
    clientId: string,
    clientSecret?: string,
}

interface Token {
    token: string,
    refreshToken?: string,
}

interface Track {
    id: string,
    is_local: boolean,
    name: string,
    uri: string,
    duration_ms: number,
}

interface Player {
    is_playing?: boolean,
    progress_ms?: number,
    item?: Track,
}

interface WebPlayerResponse {
    clientId: string,
    accessToken: string,
    accessTokenExpirationTimestampMs: number,
    isAnonymous: boolean,
}

interface LyricResponse {
    lines: Array<any>,
}

export interface Line {
    time: number,
    text: string,
}

export class spotify {
    playbackState: PlaybackState;
    event: EventEmitter;
    private token: string;
    private refreshToken?: string;
    private clientId: string;
    private clientSecret: string;
    private lastRefresh: Date;
    private cookie: string;

    constructor(clientId: string, clientSecret: string, cookie?: string,token?: string, refreshtoken?: string) {
        if(!token) {
            // Get token from .env file
            require('dotenv').config();
            token = process.env.SPOTIFY_TOKEN;
            refreshtoken = process.env.REFRESH_TOEN;
            cookie = process.env.COOKIE;
            if(!refreshtoken) {
                throw new Error('No token provided you can get this from spotify.auth()');
            }
        }
        this.event = new EventEmitter();
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.token = token;
        this.refreshToken = refreshtoken;
        this.lastRefresh = new Date();
        this.playbackState = {} as PlaybackState; 
        this.cookie = cookie;
        this.tokenRefresh()
    }

    private makePostRequest(url: string, config: AxiosRequestConfig<any>) {
        if (this.lastRefresh.getTime() + 3600000 < new Date().getTime()) {
            this.tokenRefresh().then(done => {
                return this.makePostRequest(url, config);
            });
        }
        return new Promise((resolve, reject) => {
            axios.post(url, config).then((response) => { 
                return resolve(response.data);
            }).catch((error) => {
                throw error;
            });
        })

    }

    private makeGetRequest(url: string, config: AxiosRequestConfig<any>) {
        if (this.lastRefresh.getTime() + 3600000 < new Date().getTime()) {
            this.tokenRefresh().then(done => {
                return this.makeGetRequest(url, config);
            });
        }
        return new Promise((resolve, reject) => {
            axios.get(url, config).then((response) => resolve(response.data)).catch((error) => {
                if (error.response.status == 403) { 
                    return resolve({lines: []})
                }
                reject(error)
            });
        })
        
    }

    private getPlayer(tries = 0) {
        return new Promise((resolve, reject) => {
            this.makeGetRequest("https://api.spotify.com/v1/me/player", {
                headers: {
                    Authorization: `Bearer ${this.token}`
                }
            }).then((data) => {
                return resolve(data);
            }).catch((error) => {
                if(tries >= 10) return reject(error);

                console.log(`An error happened while getting player data retrying in ${tries*5000}ms as tries is <10 (${tries})`)
                return resolve(setTimeout(() => { return this.getPlayer(++tries)}, 5000 * tries));
            });
        });
      }

    update() {
        this.getPlayer().then((data) => {
            const d = data as Player;
            if(!d.is_playing) {
                console.log("Not playing.. Waiting 5 seconds and retrying")
                return setTimeout(() => {
                    this.update();
                }, 5000);
            }
            if(this.playbackState.trackId != d?.item?.id) {
                this.playbackState.oldTrackId = this.playbackState.trackId;
                this.playbackState.trackId = d?.item?.id;
                this.playbackState.trackName = d?.item?.name;
                this.playbackState.trackDuration = 0;
                this.playbackState.trackProgress = 0;
                this.playbackState.hasLyrics = false;
                this.playbackState.lyrics = [];
                this.playbackState.currentLyrics = null;

                this.WebPlayerToken().then((tokens) => {
                    const token = tokens as WebPlayerResponse;
                    this.makeGetRequest(`https://spclient.wg.spotify.com/lyrics/v1/track/${this.playbackState.trackId}`, 
                    { headers: { 
                        Authorization: `Bearer ${token.accessToken}`, 
                        "Content-Type": "application/json",
                    }
                    })
                    .then((lyricData) => {
                        const resp = lyricData as LyricResponse;
                        if (!resp.lines.length) {
                            console.log("No lyrics found for this song :( waiting 5 seconds and retrying");
                            return setTimeout(() => {
                                this.update();
                            }, 5000);
                        }
                        if(resp.lines[0]?.time) {
                            const lines = resp.lines.filter((line) => line.time > d.progress_ms).map((line) => {
                                return {
                                        time: line.time,
                                        text: line.words.map(w => w.string).join(" "),
                                }
                            });
                            this.playbackState.lyrics = lines;
                            return setTimeout(() => {this.update()}, lines[0].time - d.progress_ms)
                        } else {
                            const timePerLyric = Math.round(this.playbackState.trackDuration / resp.lines.length);
                            const lines = resp.lines.map((line, index) => {
                                return {
                                    time: timePerLyric * index,
                                    text: line.words.map(w => w.string).join(" "),
                                }
                            });
                            this.playbackState.lyrics = lines;
                            return setTimeout(() => {this.update()}, lines[0].time - d.progress_ms)
                        }
    
                    })
                })

            } else if (this.playbackState.trackId == d?.item?.id && (this.playbackState?.lyrics?.length ?? 0)) {
                const lyric = this.playbackState.lyrics.shift();
                this.event.emit("lyricUpdate", lyric, this.playbackState.lyrics);
                return setTimeout(() => {this.update()}, this.playbackState.lyrics.length ? this.playbackState.lyrics[0].time - lyric.time : 5000)
            } else {
                return setTimeout(() => {this.update()}, 5000);
            }
        })
    }

    private WebPlayerToken() {
        return new Promise((resolve, reject) => {
            this.makeGetRequest("https://open.spotify.com/get_access_token?reason=transport&productType=web_player", {headers: {"Cookie": this.cookie}}).then((data) => {
                return resolve(data);
            })
        })
    }

    private tokenRefresh(): Promise<void> {
        return new Promise((resolve, reject) => {
            const tokenParams = new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: this.refreshToken,
                client_id: this.clientId,
                client_secret: this.clientSecret,
            });

            axios.post("https://accounts.spotify.com/api/token", tokenParams).then((response) => { 
                const { access_token } = response.data;
                console.log('New Access Token:', access_token);
                this.token = access_token;
                return resolve()
            }).catch((error) => {
                console.log(`${error.response.status} ${error.response.statusText}`);
            });

        });
    }

    static auth(client: Client, code?: string): Promise<Token> {
        return new Promise((resolve, reject) => {
          if (!code) {
            const authorizationParams = new URLSearchParams({
              response_type: 'code',
              client_id: client.clientId,
              redirect_uri: "http://example.com",
              scope: "user-read-currently-playing user-read-playback-state"
            });
      
            process.stdout.write(`https://accounts.spotify.com/authorize?${authorizationParams.toString()}\n`);
            process.stdout.write('authorize the above URL and pass in the code instead to get the token');
            process.exit(0);
          } else if (code && client.clientSecret) {
            code = code.includes("=") ? code.split('=')[1] : code;
            const tokenParams = new URLSearchParams({
              grant_type: 'authorization_code',
              code: code,
              redirect_uri: "http://example.com",
              client_id: client.clientId,
              client_secret: client.clientSecret,
            });
      
            axios.post("https://accounts.spotify.com/api/token", tokenParams)
              .then((response) => {
                const { access_token, refresh_token } = response.data;
      
                console.log('Access Token:', access_token);
                console.log('Refresh Token:', refresh_token);
      
                resolve({ token: access_token, refreshToken: refresh_token });
              })
              .catch((error) => {
                console.error('Error:', error);
                reject(error);
              });
          } else {
            reject(new Error('No client secret provided'));
          }
        });
      }

}