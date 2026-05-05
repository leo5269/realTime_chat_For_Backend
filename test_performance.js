const Ably = require('ably');
const client = new Ably.Realtime('4b0T5w.1DqtYQ:SY1t3uMjRY6UcSmMGKBSg938sYm1kZmMgvazhupgNq8');
const channel = client.channels.get('dlt-chat');

client.connection.on('connected', () => {
  console.log('連線成功，發送測試訊號...');
  channel.publish('performance', {
    scene: '第四幕',
    bowDetected: true,
    bowAngle: 32.5,
    postureScore: 0.85,
    serveGestureDetected: true,
    distanceTooClose: false,
    voiceVolume: 0.25
  });
  setTimeout(() => {
    console.log('發送完成，關閉連線');
    client.close();
  }, 1000);
});