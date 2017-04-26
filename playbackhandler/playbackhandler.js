var processes = {};
var timeposition = 0;
var mainWindowRef
var mpv = require('node-mpv');
var mpvPlayer
var playerWindowId
var mpvPath
var playMediaSource
var playerStatus
var externalSubIndexes
var playerConfig
var playerStarted = false;
var playerStopped = false;

function alert(text) {
    require('electron').dialog.showMessageBox(mainWindowRef, {
        message: text.toString(),
        buttons: ['ok']
    });
}

function download(url, dest) {
    return new Promise(function (resolve, reject) {
        var http = require('http');
        var fs = require('fs');
        var file = fs.createWriteStream(dest);
        var request = http.get(url, function (response) {
            response.pipe(file);
            file.on('finish', function () {
                file.close(resolve);  // close() is async, call cb after close completes.
            });
        }).on('error', function (err) { // Handle errors
            fs.unlink(dest); // Delete the file async. (But we don't check the result)
            reject();
        });
    });
}

function play(path) {
    return new Promise(function (resolve, reject) {
        console.log('Play URL : ' + path);
        playerStarted = false;
        mpvPlayer.loadFile(path);

        (function checkStarted(i) {
            setTimeout(function () {
                if (playerStarted) resolve();
                if (--i) checkStarted(i);
                else reject();
            }, 100)
        })(100);
    });
}

function stop() {
    mpvPlayer.stop();
}

function pause() {
    mpvPlayer.pause();
}

function pause_toggle() {
    mpvPlayer.togglePause();
}

function set_position(data) {
    mpvPlayer.goToPosition(data / 10000000);
}

function set_volume(data) {
    mpvPlayer.volume(data);
}

function mute() {
    mpvPlayer.mute();
}

function unmute() {
    mpvPlayer.unmute();
}

function set_audiostream(index) {

    var audioIndex = 0;
    var i, length, stream;
    var streams = playMediaSource.MediaStreams || [];
    for (i = 0, length = streams.length; i < length; i++) {
        stream = streams[i];
        if (stream.Type === 'Audio') {
            audioIndex++;
            if (stream.Index == index) {
                break;
            }
        }
    }
    mpvPlayer.setProperty("aid", audioIndex);
}

function set_subtitlestream(index) {

    if (index < 0) {
        mpvPlayer.setProperty("sid", "no");
    } else {
        var subIndex = 0;
        var i, length, stream;
        var streams = playMediaSource.MediaStreams || [];
        for (i = 0, length = streams.length; i < length; i++) {
            stream = streams[i];
            if (stream.Type === 'Subtitle') {
                subIndex++;

                if (stream.Index == index) {
                    if (stream.DeliveryMethod === 'External') {
                        if (stream.Index in externalSubIndexes) {
                            mpvPlayer.setProperty("sid", externalSubIndexes[stream.Index]);
                        } else {
                            var os = require('os');
                            var subtitlefile = os.tmpdir() + "/" + "subtitle" + new Date().getTime() + "." + stream.Codec.toLowerCase();
                            download(stream.DeliveryUrl, subtitlefile).then(() => {
                                mpvPlayer.addSubtitles(subtitlefile, "select", stream.DisplayTitle, stream.Language);
                                mpvPlayer.getProperty('sid').then(function (sid) {
                                    externalSubIndexes[stream.Index] = sid;
                                }).catch(() => {
                                    console.log("Failed to download " + stream.DeliveryUrl);
                                });
                            });
                        }
                    } else {
                        mpvPlayer.setProperty("sid", subIndex);
                    }

                    break;
                }
            }
        }
    }
}

function set_config(config) {
    if (!mpvPlayer) return;

    if (config.Video.hwdec != null) {
        mpvPlayer.setProperty("hwdec", config.Video.hwdec.toLowerCase());
    }

    if (config.Video['video-output-levels'] != null) {
        mpvPlayer.setProperty("video-output-levels", config.Video['video-output-levels'].toLowerCase());
    }

    if (config.Video.deinterlace != null) {
        mpvPlayer.setProperty("deinterlace", config.Video.deinterlace.toLowerCase());
    }

    if (config.Audio['audio-spdif'] != null) {
        mpvPlayer.setProperty("audio-spdif", config.Audio['audio-spdif'].toLowerCase());
    }
    
    if (config.Audio['audio-channels'] != null) {
        mpvPlayer.setProperty("audio-channels", config.Audio['audio-channels'].toLowerCase());
    }

    if (config.Audio['ad-lavc-ac3drc'] != null) {
        mpvPlayer.setProperty("ad-lavc-ac3drc", config.Audio['ad-lavc-ac3drc'].toLowerCase());
    }
}

function getReturnJson(positionTicks) {
    var playState = "playing";
    if (playerStatus.pause) {
        playState = "paused";
    }
    if (playerStatus['idle-active']) {
        playState = "idle";
    }

    var state = {
        isPaused: playerStatus.pause || false,
        isMuted: playerStatus.mute || false,
        volume: playerStatus.volume || 100,
        positionTicks: positionTicks || timeposition,
        playstate: playState
    }

    if (playerStatus.duration) {

        state.durationTicks = playerStatus.duration * 10000000;
    } else if (playerStatus['demuxer-cache-time']) {
        state.durationTicks = playerStatus['demuxer-cache-time'] * 10000000;
    }

    return Promise.resolve(JSON.stringify(state));
}

function processRequest(request, body, callback) {

    var url = require('url');
    var url_parts = url.parse(request.url, true);
    var action = url_parts.pathname.substring(1).toLowerCase();

    switch (action) {

        case 'play':
            createMpv();
            externalSubIndexes = {};
            var data = JSON.parse(body);
            var startPositionTicks = data["startPositionTicks"];
            playMediaSource = JSON.parse(data.mediaSource);

            play(data.path).then(() => {
                if (playMediaSource.DefaultAudioStreamIndex != null) {
                    set_audiostream(playMediaSource.DefaultAudioStreamIndex);
                }

                if (playMediaSource.DefaultSubtitleStreamIndex != null) {
                    set_subtitlestream(playMediaSource.DefaultSubtitleStreamIndex);
                }
                else {
                    set_subtitlestream(-1);
                }

                if (startPositionTicks != 0) {
                    set_position(startPositionTicks);
                }

                getReturnJson(startPositionTicks).then(callback);
            }).catch(() => {
                callback(null);
            });

            break;
        case 'stop':
            stop();
            getReturnJson().then(callback);
            break;
        case 'stopfade':
            // TODO: If playing audio, stop with a fade out
            stop();
            delete mpvPlayer;
            getReturnJson().then(callback);
            break;
        case 'positionticks':
            var data = url_parts.query["val"];
            set_position(data);
            timeposition = data;
            getReturnJson().then(callback);
            break;
        case 'unpause':
            pause_toggle();
            getReturnJson().then(callback);
            break;
        case 'playpause':
            pause_toggle();
            getReturnJson().then(callback);
            break;
        case 'pause':
            pause();
            getReturnJson().then(callback);
            break;
        case 'volume':
            var data = url_parts.query["val"];
            set_volume(data);
            getReturnJson().then(callback);
            break;
        case 'mute':
            mute();
            getReturnJson().then(callback);
            break;
        case 'unmute':
            unmute();
            getReturnJson().then(callback);
            break;
        case 'setaudiostreamindex':
            var data = url_parts.query["index"];
            set_audiostream(data);
            getReturnJson().then(callback);
            break;
        case 'setsubtitlestreamindex':
            var data = url_parts.query["index"];
            set_subtitlestream(data);
            getReturnJson().then(callback);
            break;
        case 'config':
            playerConfig = JSON.parse(body);
            set_config(playerConfig);
            getReturnJson().then(callback);
            break;
        default:
            // This could be a refresh, e.g. player polling for data
            getReturnJson().then(callback);
            break;
    }
}

function initialize(playerWindowIdString, mpvBinaryPath) {
    playerWindowId = playerWindowIdString;
    mpvPath = mpvBinaryPath;
}

function createMpv() {
    if (mpvPlayer) return;
    var isWindows = require('is-windows');

    var mpvOptions = [
            "--wid=" + playerWindowId,
            "--no-osc"
    ];

    if (isWindows()) {
        mpvPlayer = new mpv({
            "binary": mpvPath,
            "ipc_command": "--input-ipc-server",
            "socket": "\\\\.\\pipe\\emby-pipe",
            "debug": false

        }, mpvOptions);
    } else {
        mpvPlayer = new mpv({
            "binary": mpvPath,
            "ipc_command": "--input-unix-socket",
            "socket": "/tmp/emby.sock",
            "debug": false

        }, mpvOptions);
    }

    mpvPlayer.observeProperty('idle-active', 13);
    mpvPlayer.observeProperty('demuxer-cache-time', 14);

    mpvPlayer.on('timeposition', function (data) {
        timeposition = data * 10000000;
    });

    mpvPlayer.on('started', function () {
        playerStarted = true;
        playerStopped = false;
        mainWindowRef.focus();
    });

    mpvPlayer.on('statuschange', function (status) {
        playerStatus = status;
    });

    mpvPlayer.on('stopped', function () {
        timeposition = 0;
        playerStopped = true;
    });

    if (playerConfig) {
        set_config(playerConfig);
    }
}

function processNodeRequest(req, res) {

    var body = [];

    req.on('data', function (chunk) {
        body.push(chunk);
    }).on('end', function () {

        body = Buffer.concat(body).toString();
        // at this point, `body` has the entire request body stored in it as a string

        processRequest(req, body, function (json) {
            if (json != null) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(json);
            } else {
                res.writeHead(500);
                res.end();
            }
        });
    });
}

function registerMediaPlayerProtocol(protocol, mainWindow) {

    mainWindowRef = mainWindow;

    var http = require('http');

    http.createServer(processNodeRequest).listen(8023, '127.0.0.1');
}

exports.initialize = initialize;
exports.registerMediaPlayerProtocol = registerMediaPlayerProtocol;