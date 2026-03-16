require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.use(cors());
app.use(express.json());

// 提供靜態前端（把 audience_chat.html 放在同目錄下）
app.use(express.static(__dirname));

// AI 聊天 API
app.post('/api/ai-chat', async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: '伺服器未設定 OPENAI_API_KEY' });
  }

  const { prompt, max_tokens = 100 } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: '缺少 prompt 參數' });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('OpenAI 錯誤:', err);
      return res.status(502).json({ error: 'OpenAI API 錯誤' });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || '';
    res.json({ reply });

  } catch (err) {
    console.error('伺服器錯誤:', err);
    res.status(500).json({ error: '伺服器內部錯誤' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ 伺服器啟動：http://localhost:${PORT}`);
});
