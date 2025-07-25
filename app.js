require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const { TranscribeStreamingClient, StartStreamTranscriptionCommand } = require('@aws-sdk/client-transcribe-streaming');
const { NodeHttp2Handler } = require('@aws-sdk/node-http-handler');

const app = express();
const port = process.env.PORT || 3000;

// Configure AWS with automatic token refresh logic
let transcribeClient = createTranscribeClient();

function createTranscribeClient() {
  return new TranscribeStreamingClient({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN
    },
    requestHandler: new NodeHttp2Handler(),
    maxAttempts: 3
  });
}

// HTTP server
const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// WebSocket server
const wss = new WebSocket.Server({ server });

// Enhanced error types
const TRANSCRIBE_ERRORS = {
  BAD_REQUEST: 'BadRequestException',
  CONFLICT: 'ConflictException',
  INTERNAL_FAILURE: 'InternalFailureException',
  LIMIT_EXCEEDED: 'LimitExceededException',
  SERVICE_UNAVAILABLE: 'ServiceUnavailableException',
  EXPIRED_TOKEN: 'ExpiredTokenException',
  STREAM_CLOSED: 'ERR_STREAM_PREMATURE_CLOSE',
  SPEAKER_NOT_SUPPORTED: 'UnsupportedOperationException'
};

wss.on('connection', (ws) => {
  console.log('New client connected');
  
  let transcribeStream;
  let audioInputBuffer = [];
  let isTranscribing = false;
  let isClientConnected = true;
  let currentSpeaker = null;
  let speakerSegments = {};
  let speakerColors = {}; // To maintain consistent colors for speakers
  let nextColorIndex = 0;
  const colorPalette = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A',
    '#98D8C8', '#F06292', '#7986CB', '#9575CD'
  ];

  const sendError = (errorType, message, fatal = false) => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify({
          type: 'error',
          error: errorType,
          message: message,
          fatal: fatal
        }));
      } catch (err) {
        console.error('Error sending error message:', err);
      }
    }
    
    if (fatal && ws.readyState === ws.OPEN) {
      ws.close(1011, `Fatal error: ${errorType}`);
    }
  };

  const getSpeakerColor = (speakerLabel) => {
    if (!speakerColors[speakerLabel]) {
      speakerColors[speakerLabel] = colorPalette[nextColorIndex % colorPalette.length];
      nextColorIndex++;
    }
    return speakerColors[speakerLabel];
  };

  const handleTranscribeError = (err) => {
    console.error('Transcribe error:', err);
    
    if (err.name === TRANSCRIBE_ERRORS.EXPIRED_TOKEN) {
      sendError('TOKEN_EXPIRED', 'AWS credentials have expired', true);
      try {
        transcribeClient = createTranscribeClient();
        console.log('Recreated Transcribe client with fresh credentials');
      } catch (refreshErr) {
        console.error('Failed to refresh AWS credentials:', refreshErr);
      }
      return;
    }
    
    if (err.code === TRANSCRIBE_ERRORS.STREAM_CLOSED) {
      sendError('STREAM_CLOSED', 'Audio stream closed prematurely', true);
      return;
    }

    // Handle speaker diarization not supported
    if (err.name === TRANSCRIBE_ERRORS.SPEAKER_NOT_SUPPORTED) {
      sendError('SPEAKER_NOT_SUPPORTED', 'Speaker diarization not supported in this region', true);
      return;
    }

    switch (err.name) {
      case TRANSCRIBE_ERRORS.BAD_REQUEST:
        sendError('BAD_REQUEST', 'Invalid transcription request parameters', true);
        break;
      case TRANSCRIBE_ERRORS.CONFLICT:
        sendError('CONFLICT', 'Conflicting transcription operation', true);
        break;
      case TRANSCRIBE_ERRORS.LIMIT_EXCEEDED:
        sendError('LIMIT_EXCEEDED', 'Transcription request rate limit exceeded', true);
        break;
      case TRANSCRIBE_ERRORS.SERVICE_UNAVAILABLE:
        sendError('SERVICE_UNAVAILABLE', 'Transcription service unavailable', true);
        break;
      case TRANSCRIBE_ERRORS.INTERNAL_FAILURE:
        sendError('INTERNAL_FAILURE', 'Internal AWS service failure', true);
        break;
      default:
        sendError('TRANSCRIPTION_FAILED', 'Failed to process audio stream', true);
    }
  };

  const startStream = async (attempt = 1) => {
    try {
      const command = new StartStreamTranscriptionCommand({
        LanguageCode: 'en-US',
        MediaEncoding: 'pcm',
        MediaSampleRateHertz: 44100,
        EnableSpeakerIdentification: true,
        ShowSpeakerLabel: true,
        AudioStream: (async function* () {
          while (isClientConnected && isTranscribing) {
            if (audioInputBuffer.length > 0) {
              const chunk = audioInputBuffer.shift();
              yield { AudioEvent: { AudioChunk: chunk } };
            } else {
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }
        })(),
      });

      isTranscribing = true;
      transcribeStream = await transcribeClient.send(command);
      
      for await (const event of transcribeStream.TranscriptResultStream) {
        if (!isTranscribing || !isClientConnected) break;
        
        if (event.TranscriptEvent) {
          const results = event.TranscriptEvent.Transcript.Results;
          if (results.length > 0 && results[0].Alternatives.length > 0) {
            const result = results[0];
            const alternative = result.Alternatives[0];
            
            const message = {
              type: 'transcript',
              text: alternative.Transcript,
              isPartial: result.IsPartial,
              speaker: null,
              speakerColor: null,
              items: [],
              speakerSegments: []
            };
            
            // Process speaker information
            if (result.Speaker) {
              currentSpeaker = result.Speaker;
              if (!speakerSegments[currentSpeaker]) {
                speakerSegments[currentSpeaker] = {
                  speaker: currentSpeaker,
                  segments: [],
                  color: getSpeakerColor(currentSpeaker)
                };
              }
              message.speaker = currentSpeaker;
              message.speakerColor = speakerSegments[currentSpeaker].color;
            }
            
            // Process individual items with timing and speaker info
            if (alternative.Items) {
              message.items = alternative.Items.map(item => ({
                content: item.Content,
                type: item.Type,
                startTime: item.StartTime,
                endTime: item.EndTime,
                speaker: item.Speaker || currentSpeaker,
                speakerColor: item.Speaker ? getSpeakerColor(item.Speaker) : message.speakerColor
              }));
            }
            
            // Build speaker segments for the UI to show speaker timeline
            message.speakerSegments = Object.values(speakerSegments).map(speaker => ({
              speaker: speaker.speaker,
              color: speaker.color,
              duration: speaker.segments.reduce((total, seg) => total + (seg.endTime - seg.startTime), 0)
            }));
            
            if (ws.readyState === ws.OPEN) {
              try {
                ws.send(JSON.stringify(message));
              } catch (sendErr) {
                console.error('Error sending transcript:', sendErr);
                break;
              }
            }
          }
        }
      }
    } catch (err) {
      handleTranscribeError(err);
      
      if (err.name === TRANSCRIBE_ERRORS.EXPIRED_TOKEN && attempt === 1) {
        console.log('Attempting to reconnect with refreshed credentials...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        return startStream(attempt + 1);
      }
    } finally {
      isTranscribing = false;
    }
  };

  const stopTranscription = async () => {
    try {
      isTranscribing = false;
      
      if (transcribeStream) {
        await transcribeStream.TranscriptResultStream.controller.abort();
        transcribeStream = null;
      }
      
      // Send final speaker summary
      if (ws.readyState === ws.OPEN && Object.keys(speakerSegments).length > 0) {
        const summary = {
          type: 'speakerSummary',
          speakers: Object.values(speakerSegments).map(speaker => ({
            speaker: speaker.speaker,
            color: speaker.color,
            duration: speaker.segments.reduce((total, seg) => total + (seg.endTime - seg.startTime), 0),
            wordCount: speaker.segments.reduce((total, seg) => total + seg.words, 0)
          }))
        };
        ws.send(JSON.stringify(summary));
      }
    } catch (err) {
      console.error('Error stopping transcription:', err);
      sendError('STOP_ERROR', 'Error stopping transcription');
    }
  };

  // Start transcription when connection is established
  startStream().catch(console.error);

  ws.on('message', (message) => {
    try {
      if (!isTranscribing) {
        throw new Error('Transcription not active');
      }
      
      const data = JSON.parse(message);
      
      if (data.type === 'audio') {
        if (!data.chunk || typeof data.chunk !== 'string') {
          throw new Error('Invalid audio chunk format');
        }
        
        const audioChunk = Buffer.from(data.chunk, 'base64');
        
        if (audioChunk.length > 10 * 1024) {
          throw new Error('Audio chunk too large');
        }
        
        audioInputBuffer.push(audioChunk);
      }
    } catch (err) {
      console.error('Error processing message:', err);
      sendError('INVALID_MESSAGE', err.message);
    }
  });

  // Heartbeat mechanism
  const heartbeatInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    } else {
      clearInterval(heartbeatInterval);
    }
  }, 30000);

  ws.on('pong', () => {
    // Client is still alive
  });

  ws.on('close', async () => {
    console.log('Client disconnected');
    isClientConnected = false;
    clearInterval(heartbeatInterval);
    await stopTranscription();
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    isClientConnected = false;
    clearInterval(heartbeatInterval);
    stopTranscription();
  });
});

// Handle process termination gracefully
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});