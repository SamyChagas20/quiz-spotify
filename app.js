require('dotenv').config();
console.log('[DEBUG] REDIRECT URI em uso:', process.env.SPOTIFY_REDIRECT_URI);
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
  cookie: { maxAge: 1000 * 60 * 30 } // 30 minutos
}));

// --- Instância "de App" (Client Credentials) — busca dados públicos, sem login de usuário ---
const spotifyApiApp = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET
});

let tokenAppExpiraEm = 0;

async function garantirTokenApp() {
  if (Date.now() < tokenAppExpiraEm) return; // ainda válido, evita chamada desnecessária

  const data = await spotifyApiApp.clientCredentialsGrant();
  spotifyApiApp.setAccessToken(data.body['access_token']);
  tokenAppExpiraEm = Date.now() + (data.body['expires_in'] - 60) * 1000; // renova 1min antes de expirar
}

// --- Instância "de Auth" — só pra gerar a URL de login e trocar o código por tokens ---
// Não guarda estado de usuário, então pode ser compartilhada com segurança.
const spotifyApiAuth = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI
});

console.log("O Client ID lido foi:", process.env.SPOTIFY_CLIENT_ID);

// ============ ROTAS ============

// 1. PÁGINA INICIAL → redireciona pro quiz
app.get('/', (req, res) => {
  res.redirect('/quiz');
});

// 2. PÁGINA DO QUIZ
app.get('/quiz', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'quiz.html'));
});

// 3. GERA AS PERGUNTAS DO QUIZ PRA UM ARTISTA
app.post('/api/quiz/gerar', async (req, res) => {
  try {
    const { artista } = req.body;
    if (!artista || !artista.trim()) {
      return res.status(400).json({ erro: 'Informe o nome de um artista.' });
    }

    await garantirTokenApp();
    const dados = await buscarDadosArtista(spotifyApiApp, artista.trim());
    const perguntas = await gerarPerguntas(spotifyApiApp, dados);

    // Guarda os dados completos (com gabarito) NA SESSÃO deste usuário
    req.session.quizAtual = { dados, perguntas };

    // Remove o gabarito antes de enviar ao front
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

// 4. CALCULA O RESULTADO E O PERFIL DO FÃ
app.post('/api/quiz/resultado', (req, res) => {
  try {
    const { respostas } = req.body;
    const quizAtual = req.session.quizAtual;

    if (!quizAtual) {
      return res.status(400).json({ erro: 'Nenhum quiz ativo. Gere um novo quiz primeiro.' });
    }

    const resultado = gerarResultado(quizAtual.dados, quizAtual.perguntas, respostas || {});

    // Guarda o resultado NA SESSÃO, pra usar depois do login
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

// 5. INICIA O LOGIN PRA CRIAR A PLAYLIST DO RESULTADO
app.get('/quiz/criar-playlist', (req, res) => {
  if (!req.session.resultadoQuiz) {
    return res.status(400).send('<p>Nenhum resultado de quiz disponível. Refaça o quiz em <a href="/quiz">/quiz</a>.</p>');
  }

  const scopes = ['playlist-modify-public', 'playlist-modify-private', 'user-read-private', 'user-read-email'];
  const authUrl = spotifyApiAuth.createAuthorizeURL(scopes, null, true);

  // Página de transição que avisa o usuário antes de redirecionar
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
      <p>Você será redirecionado em instantes para autorizar a criação da playlist.</p>
    </div>
    <script>
      setTimeout(() => { window.location.href = '${authUrl}'; }, 3000);
    </script>
  `);
});

// 6. CALLBACK — onde o Spotify devolve o código de autorização
app.get('/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('<h1>Erro:</h1><p>Nenhum código recebido. Comece pela página inicial.</p>');
  }

  const resultadoQuiz = req.session.resultadoQuiz;
  if (!resultadoQuiz) {
    return res.status(400).send('<p>Nenhum resultado de quiz disponível. Refaça o quiz em <a href="/quiz">/quiz</a>.</p>');
  }

  try {
    // Troca o código pelos tokens (instância de auth compartilhada, sem efeito colateral)
    const dataToken = await spotifyApiAuth.authorizationCodeGrant(code);
    const accessToken = dataToken.body['access_token'];
    const refreshToken = dataToken.body['refresh_token'];

    console.log(`[Tokens] Access Token gerado nesta sessão: ${accessToken.substring(0, 15)}...`);

    // Instância PRÓPRIA deste usuário/requisição
    const spotifyApiUsuario = new SpotifyWebApi({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      redirectUri: process.env.SPOTIFY_REDIRECT_URI
    });
    spotifyApiUsuario.setAccessToken(accessToken);
    spotifyApiUsuario.setRefreshToken(refreshToken);

    // Busca dados do usuário logado
    const me = await spotifyApiUsuario.getMe();
    const usuarioId = me.body.id;

    // Cria a playlist física no perfil do usuário
    console.log(`[Spotify] Criando playlist para o usuário: ${usuarioId}`);
    const criacaoPlaylist = await spotifyApiUsuario.createPlaylist(usuarioId, {
      name: resultadoQuiz.nomePlaylist,
      description: resultadoQuiz.descricao,
      public: false
    });

    const playlistId = criacaoPlaylist.body.id;
    const playlistUrl = criacaoPlaylist.body.external_urls.spotify;
    console.log(`[Spotify] Playlist vazia criada! ID: ${playlistId}`);

    // Pausa estratégica pra sincronia dos servidores do Spotify
    console.log('[Spotify] Aguardando sincronia de segurança...');
    await new Promise(resolve => setTimeout(resolve, 2500));

    // Renova o token antes da injeção
    console.log('[Spotify] Renovando token antes da injeção...');
    const refreshData = await spotifyApiUsuario.refreshAccessToken();
    const accessTokenAtual = refreshData.body['access_token'];
    spotifyApiUsuario.setAccessToken(accessTokenAtual);

    // Injeção via /items, em lotes de 100
    const LOTE_MAXIMO = 100;
    const uris = resultadoQuiz.uris;

    console.log(`[Spotify] Injetando ${uris.length} músicas na playlist...`);

    for (let i = 0; i < uris.length; i += LOTE_MAXIMO) {
      const lote = uris.slice(i, i + LOTE_MAXIMO);
      console.log(`[Spotify] Injetando lote ${Math.floor(i / LOTE_MAXIMO) + 1}: ${lote.length} faixas (via /items)...`);

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

      console.log(`[Spotify] Lote ${Math.floor(i / LOTE_MAXIMO) + 1} adicionado com sucesso!`);

      if (i + LOTE_MAXIMO < uris.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log(`[Spotify] Músicas adicionadas com sucesso!`);

    // Limpa os dados do quiz dessa sessão (já foram usados)
    delete req.session.quizAtual;
    delete req.session.resultadoQuiz;

    // Tela visual de sucesso
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
        <p>A playlist <strong>"${resultadoQuiz.nomePlaylist}"</strong> foi gerada e populada no seu Spotify.</p>
        <a class="btn" href="${playlistUrl}" target="_blank">Abrir no Spotify</a>
      </div>
    `);

  } catch (error) {
      console.error('Erro detalhado no callback:', error);

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
            <h1>Função em testes</h1>
            <p>A criação automática de playlist está disponível apenas para contas autorizadas durante esta fase de testes.</p>
            <p>Mas não se preocupe! Você ainda pode <a href="/quiz">voltar ao quiz</a> e usar os links de cada música pra adicionar manualmente à sua playlist no Spotify.</p>
          </div>
        `);
      }

      res.status(500).send('<h1>Erro no Processamento</h1><p>Ocorreu um problema ao gerar ou popular a playlist. Verifique o console do servidor para detalhes.</p>');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});