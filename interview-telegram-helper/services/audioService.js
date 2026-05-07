const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

let ffmpegProcess = null;

function listAudioDevices() {
    return new Promise((resolve) => {
        const ffmpeg = spawn('ffmpeg', ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
        let output = '';

        ffmpeg.stderr.on('data', (data) => {
            output += data.toString();
        });

        ffmpeg.on('close', () => {
            const devices = [];
            const lines = output.split('\n');
            let captureNext = false;

            for (let line of lines) {
                if (line.includes('(audio)')) {
                    const match = line.match(/"([^"]+)"/);
                    if (match) {
                        devices.push(match[1]);
                    }
                }
            }
            // Filter out unique devices and return
            resolve([...new Set(devices)]);
        });
    });
}

function startRecording(deviceName, outputPath) {
    return new Promise((resolve, reject) => {
        if (ffmpegProcess) {
            return reject(new Error('Recording already in progress'));
        }

        // ffmpeg -f dshow -i audio="DEVICE_NAME" -y output.wav
        // -y to overwrite if exists
        ffmpegProcess = spawn('ffmpeg', [
            '-f', 'dshow',
            '-i', `audio=${deviceName}`,
            '-y',
            outputPath
        ]);

        ffmpegProcess.on('error', (err) => {
            ffmpegProcess = null;
            reject(err);
        });

        // We resolve once it starts successfully
        // Small delay to ensure it's actually running
        setTimeout(() => {
            if (ffmpegProcess) resolve();
            else reject(new Error('FFmpeg failed to start'));
        }, 1000);
    });
}

function stopRecording() {
    return new Promise((resolve) => {
        if (!ffmpegProcess) {
            return resolve();
        }

        // Standard way to stop ffmpeg is sending 'q' to stdin
        ffmpegProcess.stdin.write('q');

        ffmpegProcess.on('close', () => {
            ffmpegProcess = null;
            resolve();
        });
        
        // Timeout backup
        setTimeout(() => {
            if (ffmpegProcess) {
                ffmpegProcess.kill('SIGINT');
                ffmpegProcess = null;
                resolve();
            }
        }, 2000);
    });
}

module.exports = { listAudioDevices, startRecording, stopRecording };
