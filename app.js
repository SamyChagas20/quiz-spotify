const express = require('express');
const session = require('express-session');
const SpotifyWebApi = require('spotify-web-api-node');
const path = require('path');
const { buscarDadosArtista, gerarPerguntas, gerarResultado } = require('./quizGerador');

const app = express();

app.use(express.static('public'));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 1000 * 60 * 30 }
}));

const spotifyApiApp = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET
});

let tokenAppExpiraEm = 0;

async function garantirTokenApp() {
  if (Date.now() < tokenAppExpiraEm) return;
  const data = await spotifyApiApp.clientCredentialsGrant();
  spotifyApiApp.setAccessToken(data.body['access_token']);
  tokenAppExpiraEm = Date.now() + (data.body['expires_in'] - 60) * 1000;
}

const spotifyApiAuth = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI
});

console.log('[Server] Client ID:', process.env.SPOTIFY_CLIENT_ID);
console.log('[Server] Redirect URI:', process.env.SPOTIFY_REDIRECT_URI);

app.get('/', (req, res) => {
  res.redirect('/quiz');
});

app.get('/quiz', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'quiz.html'));
});

app.post('/api/quiz/gerar', async (req, res) => {
  try {
    const { artista } = req.body;
    if (!artista || !artista.trim()) {
      return res.status(400).json({ erro: 'Informe o nome de um artista.' });
    }

    await garantirTokenApp();
    const dados = await buscarDadosArtista(spotifyApiApp, artista.trim());
    const perguntas = await gerarPerguntas(spotifyApiApp, dados);

    req.session.quizAtual = { dados, perguntas };

    const perguntasPublicas = perguntas.map(({ respostaCorreta, ...resto }) => resto);

    res.json({
      artista: { nome: dados.artista.name, imagem: dados.artista.images[0]?.url || null },
      perguntas: perguntasPublicas
    });
  } catch (erro) {
    console.error('[Quiz] Erro ao gerar quiz:', erro.message);
    console.error('[Quiz] Detalhes:', JSON.stringify(erro.body || erro, null, 2));
    res.status(500).json({ erro: erro.message || 'Erro ao gerar o quiz.' });
  }
});

app.post('/api/quiz/resultado', (req, res) => {
  try {
    const { respostas } = req.body;
    const quizAtual = req.session.quizAtual;

    if (!quizAtual) {
      return res.status(400).json({ erro: 'Nenhum quiz ativo. Gere um novo quiz primeiro.' });
    }

    const resultado = gerarResultado(quizAtual.dados, quizAtual.perguntas, respostas || {});
    req.session.resultadoQuiz = resultado;

    res.json({
      titulo: resultado.titulo,
      descricao: resultado.descricao,
      nomePlaylist: resultado.nomePlaylist,
      faixas: resultado.faixas
    });
  } catch (erro) {
    console.error('[Quiz] Erro ao calcular resultado:', erro.message);
    res.status(500).json({ erro: 'Erro ao calcular o resultado.' });
  }
});

app.get('/quiz/criar-playlist', (req, res) => {
  if (!req.session.resultadoQuiz) {
    return res.status(400).send('<p>Nenhum resultado disponivel. <a href="/quiz">Refaca o quiz</a>.</p>');
  }

  const scopes = ['playlist-modify-public', 'playlist-modify-private', 'user-read-private', 'user-read-email'];
  const authUrl = spotifyApiAuth.createAuthorizeURL(scopes, null, true);

  res.send(`
    <style>
      body { background-color: #121212; color: white; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; text-align: center; padding: 20px; }
      .box { max-width: 400px; }
      h2 { color: #1DB954; }
      p { color: #b3b3b3; }
      .spinner { border: 4px solid #333; border-top: 4px solid #1DB954; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
    <div class="box">
      <h2>Conectando ao Spotify...</h2>
      <div class="spinner"></div>
      <p>Voce sera redirecionado em instantes.</p>
    </div>
    <script>
      setTimeout(() => { window.location.href = '${authUrl}'; }, 3000);
    </script>
  `);
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('<h1>Erro:</h1><p>Nenhum codigo recebido.</p>');
  }

  const resultadoQuiz = req.session.resultadoQuiz;
  if (!resultadoQuiz) {
    return res.status(400).send('<p>Sessao expirada. <a href="/quiz">Refaca o quiz</a>.</p>');
  }

  try {
    const dataToken = await spotifyApiAuth.authorizationCodeGrant(code);
    const accessToken = dataToken.body['access_token'];
    const refreshToken = dataToken.body['refresh_token'];

    console.log('[Tokens] Access Token gerado:', accessToken.substring(0, 15) + '...');

    const spotifyApiUsuario = new SpotifyWebApi({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      redirectUri: process.env.SPOTIFY_REDIRECT_URI
    });
    spotifyApiUsuario.setAccessToken(accessToken);
    spotifyApiUsuario.setRefreshToken(refreshToken);

    const me = await spotifyApiUsuario.getMe();
    const usuarioId = me.body.id;

    console.log('[Spotify] Criando playlist para:', usuarioId);
    const criacaoPlaylist = await spotifyApiUsuario.createPlaylist(usuarioId, {
      name: resultadoQuiz.nomePlaylist,
      description: resultadoQuiz.descricao,
      public: false
    });

    const playlistId = criacaoPlaylist.body.id;
    const playlistUrl = criacaoPlaylist.body.external_urls.spotify;
    console.log('[Spotify] Playlist criada! ID:', playlistId);

    await new Promise(resolve => setTimeout(resolve, 2500));

    const refreshData = await spotifyApiUsuario.refreshAccessToken();
    const accessTokenAtual = refreshData.body['access_token'];
    spotifyApiUsuario.setAccessToken(accessTokenAtual);

    const LOTE_MAXIMO = 100;
    const uris = resultadoQuiz.uris;

    console.log('[Spotify] Injetando', uris.length, 'musicas...');

    for (let i = 0; i < uris.length; i += LOTE_MAXIMO) {
      const lote = uris.slice(i, i + LOTE_MAXIMO);
      console.log('[Spotify] Lote', Math.floor(i / LOTE_MAXIMO) + 1 + ':', lote.length, 'faixas...');

      const respItems = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessTokenAtual}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ uris: lote })
      });

      if (!respItems.ok) {
        const erroBody = await respItems.json();
        throw new Error(`Erro ao adicionar faixas (status ${respItems.status}): ${JSON.stringify(erroBody)}`);
      }

      if (i + LOTE_MAXIMO < uris.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log('[Spotify] Musicas adicionadas com sucesso!');

    delete req.session.quizAtual;
    delete req.session.resultadoQuiz;

    res.send(`
      <style>
        body { background-color: #121212; color: white; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .success-box { text-align: center; border: 2px solid #1DB954; padding: 40px; border-radius: 15px; background-color: #181818; max-width: 400px; box-shadow: 0 8px 24px rgba(0,0,0,0.6); }
        h1 { color: #1DB954; margin-top: 0; }
        .btn { background-color: #1DB954; color: white; padding: 15px 30px; border-radius: 30px; text-decoration: none; font-weight: bold; font-size: 16px; display: inline-block; margin-top: 20px; transition: background-color 0.2s; }
        .btn:hover { background-color: #1ed760; }
      </style>
      <div class="success-box">
        <h1>Perfil Pronto!</h1>
        <p>A playlist <strong>"${resultadoQuiz.nomePlaylist}"</strong> foi criada no seu Spotify.</p>
        <a class="btn" href="${playlistUrl}" target="_blank">Abrir no Spotify</a>
      </div>
    `);

  } catch (error) {
    console.error('Erro no callback:', error);
    const status = error.statusCode || error.body?.error?.status;

    if (status === 403) {
      return res.status(403).send(`
        <style>
          body { background-color: #121212; color: white; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; text-align: center; padding: 20px; }
          .box { max-width: 420px; }
          h1 { color: #ff5c5c; }
          a { color: #1DB954; }
        </style>
        <div class="box">
          <h1>Funcao em testes</h1>
          <p>A criacao automatica de playlist esta disponivel apenas para contas autorizadas.</p>
          <p><a href="/quiz">Voltar ao quiz</a></p>
        </div>
      `);
    }

    res.status(500).send('<h1>Erro no Processamento</h1><p>Tente novamente.</p>');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});