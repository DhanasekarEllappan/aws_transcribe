require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const { TranscribeStreamingClient, StartStreamTranscriptionCommand } = require('@aws-sdk/client-transcribe-streaming');
const { NodeHttp2Handler } = require('@aws-sdk/node-http-handler');

const app = express();
const port = process.env.PORT || 3000;

// Configure AWS client
function createTranscribeClient() {
  return new TranscribeStreamingClient({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    requestHandler: new NodeHttp2Handler(),
    maxAttempts: 3
  });
}

let transcribeClient = createTranscribeClient();

const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('New client connected');
  
  let transcribeStream;
  let audioInputBuffer = [];
  let isTranscribing = false;
  let isClientConnected = true;
  let speakerLabels = new Map(); // Track speaker labels and their colors
  const colorPalette = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F06292', '#7986CB', '#9575CD'];

  const getSpeakerColor = (speakerLabel) => {
    if (!speakerLabels.has(speakerLabel)) {
      const color = colorPalette[speakerLabels.size % colorPalette.length];
      speakerLabels.set(speakerLabel, {
        color,
        segments: [],
        wordCount: 0
      });
    }
    return speakerLabels.get(speakerLabel).color;
  };

  const startStream = async () => {
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
            
            // Initialize speaker variable
            let currentSpeaker = null;
            let speakerItems = [];

            // Process items to extract speaker information
            if (alternative.Items && alternative.Items.length > 0) {
              speakerItems = alternative.Items.map(item => {
                // Determine speaker for this item
                const itemSpeaker = item.Speaker || currentSpeaker;
                if (itemSpeaker) currentSpeaker = itemSpeaker;
                
                return {
                  content: item.Content,
                  type: item.Type,
                  startTime: item.StartTime,
                  endTime: item.EndTime,
                  speaker: itemSpeaker,
                  speakerColor: itemSpeaker ? getSpeakerColor(itemSpeaker) : null
                };
              });

              // Update speaker statistics
              if (currentSpeaker) {
                const speakerData = speakerLabels.get(currentSpeaker) || {
                  color: getSpeakerColor(currentSpeaker),
                  segments: [],
                  wordCount: 0
                };
                
                // Count words for this speaker
                const wordsInSegment = alternative.Items.filter(item => 
                  item.Type === 'pronunciation' && (item.Speaker === currentSpeaker || item.Speaker === undefined)
                ).length;
                
                speakerData.wordCount += wordsInSegment;
                speakerLabels.set(currentSpeaker, speakerData);
              }
            }

            // Prepare the message
            const message = {
              type: 'transcript',
              text: alternative.Transcript,
              isPartial: result.IsPartial,
              speaker: currentSpeaker,
              speakerColor: currentSpeaker ? getSpeakerColor(currentSpeaker) : null,
              items: speakerItems,
              speakerSegments: Array.from(speakerLabels.entries()).map(([speaker, data]) => ({
                speaker,
                color: data.color,
                wordCount: data.wordCount
              }))
            };

            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify(message));
            }
          }
        }
      }
    } catch (error) {
      console.error('Transcription error:', error);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Transcription error',
          error: error.message
        }));
      }
    } finally {
      isTranscribing = false;
    }
  };

  // Start transcription when receiving first audio message
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'audio') {
        if (!isTranscribing) {
          await startStream();
        }
        
        if (data.chunk && typeof data.chunk === 'string') {
          const audioChunk = Buffer.from(data.chunk, 'base64');
          audioInputBuffer.push(audioChunk);
        }
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', async () => {
    isClientConnected = false;
    isTranscribing = false;
    
    // Send final speaker summary
    if (ws.readyState === ws.OPEN && speakerLabels.size > 0) {
      const summary = {
        type: 'speakerSummary',
        speakers: Array.from(speakerLabels.entries()).map(([speaker, data]) => ({
          speaker,
          color: data.color,
          wordCount: data.wordCount
        }))
      };
      ws.send(JSON.stringify(summary));
    }
  });
});

// Graceful shutdown
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());