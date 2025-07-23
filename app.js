require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const { TranscribeStreamingClient, StartStreamTranscriptionCommand } = require('@aws-sdk/client-transcribe-streaming');
const { NodeHttp2Handler } = require('@aws-sdk/node-http-handler');

const app = express();
const port = process.env.PORT || 3000;

// Configure AWS
const transcribeClient = new TranscribeStreamingClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN
  },
  requestHandler: new NodeHttp2Handler()
});

// HTTP server
const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('New client connected');
  
  let transcribeStream;
  let audioInputBuffer = [];
  let processing = false;

  // Initialize AWS Transcribe Streaming
  const startStream = async () => {
    const command = new StartStreamTranscriptionCommand({
      LanguageCode: 'en-US',
      MediaEncoding: 'pcm',
      MediaSampleRateHertz: 44100,
      AudioStream: (async function* () {
        while (true) {
          if (audioInputBuffer.length > 0) {
            const chunk = audioInputBuffer.shift();
            yield { AudioEvent: { AudioChunk: chunk } };
          } else {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      })(),
    });

    transcribeStream = await transcribeClient.send(command);
    
    for await (const event of transcribeStream.TranscriptResultStream) {
      if (event.TranscriptEvent) {
        const results = event.TranscriptEvent.Transcript.Results;
        if (results.length > 0 && results[0].Alternatives.length > 0) {
          if (!results[0].IsPartial) {
            ws.send(JSON.stringify({
              type: 'transcript',
              text: results[0].Alternatives[0].Transcript,
              isPartial: false
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'transcript',
              text: results[0].Alternatives[0].Transcript,
              isPartial: true
            }));
          }
        }
      }
    }
  };

  startStream().catch(err => {
    console.error('Transcribe error:', err);
    ws.close();
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'audio') {
        // Convert base64 to binary
        const audioChunk = Buffer.from(data.chunk, 'base64');
        audioInputBuffer.push(audioChunk);
      }
    } catch (err) {
      console.error('Error processing message:', err);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    if (transcribeStream) {
      transcribeStream.destroy();
    }
  });
});