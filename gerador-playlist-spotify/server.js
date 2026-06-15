require('dotenv').config();
const express = require('express');
const SpotifyWebApi = require('spotify-web-api-node');
const path = require('path');
const { gerarListaFoco } = require('./gerador');

const app = express();

// Libera os arquivos estáticos da pasta public (HTML, CSS)
app.use(express.static('public'));
app.use(express.json());

const { buscarDadosArtista, gerarPerguntas, gerarResultado } = require('./quizGerador');

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI
});

const spotifyApiApp = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET
});

async function garantirTokenApp() {
  const data = await spotifyApiApp.clientCredentialsGrant();
  spotifyApiApp.setAccessToken(data.body['access_token']);
}

console.log("O Client ID lido foi:", process.env.SPOTIFY_CLIENT_ID);

// 1. PÁGINA INICIAL (Serve o seu index.html lindão do front-end)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'quiz.html'));
});

// 3. ROTA DE LOGIN DIRETA (Caso queira acessar direto)
app.get('/login', (req, res) => {
  const scopes = ['playlist-modify-public', 'playlist-modify-private', 'user-read-private', 'user-read-email'];
  res.redirect(spotifyApi.createAuthorizeURL(scopes));
});

// PÁGINA DO QUIZ
app.get('/quiz', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'quiz.html'));
});

// GERA AS PERGUNTAS DO QUIZ PRA UM ARTISTA
app.post('/api/quiz/gerar', async (req, res) => {
  try {
    const { artista } = req.body;
    if (!artista || !artista.trim()) {
      return res.status(400).json({ erro: 'Informe o nome de um artista.' });
    }

    await garantirTokenApp();
    const dados = await buscarDadosArtista(spotifyApiApp, artista.trim());
    const perguntas = gerarPerguntas(dados);

    // Guarda os dados completos (com gabarito) no servidor
    app.locals.quizAtual = { dados, perguntas };

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

// CALCULA O RESULTADO E O PERFIL DO FÃ
app.post('/api/quiz/resultado', (req, res) => {
  try {
    const { respostas } = req.body;
    const quizAtual = app.locals.quizAtual;

    if (!quizAtual) {
      return res.status(400).json({ erro: 'Nenhum quiz ativo. Gere um novo quiz primeiro.' });
    }

    const resultado = gerarResultado(quizAtual.dados, quizAtual.perguntas, respostas || {});
    app.locals.resultadoQuiz = resultado;

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

// INICIA O LOGIN PRA CRIAR A PLAYLIST DO RESULTADO
app.get('/quiz/criar-playlist', (req, res) => {
  if (!app.locals.resultadoQuiz) {
    return res.status(400).send('<p>Nenhum resultado de quiz disponível. Refaça o quiz.</p>');
  }
  app.locals.origemFluxo = 'quiz';
  const scopes = ['playlist-modify-public', 'playlist-modify-private', 'user-read-private', 'user-read-email'];
  res.redirect(spotifyApi.createAuthorizeURL(scopes, null, true));
});

// 4. ROTA DE CALLBACK (Onde a mágica do Spotify acontece)
app.get('/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('<h1>Erro:</h1><p>Nenhum código recebido. Comece pela página inicial.</p>');
  }

  try {
    // Troca o código temporário pelos tokens de acesso
    const data = await spotifyApi.authorizationCodeGrant(code);
    const accessToken = data.body['access_token'];
    const refreshToken = data.body['refresh_token'];

    // Injeta as credenciais na instância da API
    spotifyApi.setAccessToken(accessToken);
    spotifyApi.setRefreshToken(refreshToken);

    console.log(`[Tokens] Access Token gerado nesta sessão: ${accessToken.substring(0, 15)}...`);
    

    // Busca dados do usuário logado para saber o ID
    const me = await spotifyApi.getMe();
    const usuarioId = me.body.id;
    
    // Recupera os dados coletados do front-end (ou usa o fallback se estiver vazio)
    let resultadoGerador;

    if (app.locals.origemFluxo === 'quiz' && app.locals.resultadoQuiz) {
      resultadoGerador = app.locals.resultadoQuiz;
    } else {
      const dadosParaOAlgoritmo = app.locals.dadosAtuaisDoUsuario || {
        musicaFocoNome: "Judas",
        totalStreams: 5,
        artistasPermitidos: ["Lady Gaga"],
        artistasBanidos: ["Madonna"]
      };
      resultadoGerador = await gerarListaFoco(spotifyApi, dadosParaOAlgoritmo);
    }

    // Cria a playlist física no perfil do usuário
    console.log(`[Spotify] Criando playlist para o usuário: ${usuarioId}`);
    const criacaoPlaylist = await spotifyApi.createPlaylist(usuarioId, {
      name: resultadoGerador.nomePlaylist,
      description: 'Playlist de foco gerada automaticamente pelo Quiz.',
      public: false // <-- Deixe como false (Privada)
    });

    const playlistId = criacaoPlaylist.body.id;
    const playlistUrl = criacaoPlaylist.body.external_urls.spotify;
    console.log(`[Spotify] Playlist vazia criada! ID: ${playlistId}`);

    // Pausa estratégica de 2.5 segundos para sincronia dos servidores do Spotify
    console.log('[Spotify] Aguardando sincronia de segurança...');
    await new Promise(resolve => setTimeout(resolve, 2500));

    // Reforça o token na sessão bem colado com a inserção
    spotifyApi.setAccessToken(accessToken); 

    console.log(`[Spotify] Injetando ${resultadoGerador.uris.length} músicas na playlist...`);

    console.log('[Spotify] Renovando token antes da injeção...');
    const refreshData = await spotifyApi.refreshAccessToken();
    console.log('[DEBUG] Scopes retornados no refresh:', refreshData.body['scope']);
    spotifyApi.setAccessToken(refreshData.body['access_token']);
    console.log('[DEBUG] TOKEN COMPLETO:', refreshData.body['access_token']);
    console.log('[DEBUG] SCOPES:', refreshData.body['scope']);
    
    console.log('[DEBUG] URIs a enviar:', JSON.stringify(resultadoGerador.uris, null, 2));
    console.log('[DEBUG] Total de URIs:', resultadoGerador.uris.length);
    console.log('[DEBUG] Algum URI inválido?', resultadoGerador.uris.some(u => !u || !u.startsWith('spotify:track:')));
    
    // Injeção direta usando o Array cru
    // Pega o token atualizado (pós-refresh) pra usar nas requisições
    const accessTokenAtual = refreshData.body['access_token'];

    // Injeção via novo endpoint /items, em lotes de 100 (limite da API)
    const LOTE_MAXIMO = 100;
    const uris = resultadoGerador.uris;

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
        <h1>Estratégia Pronta!</h1>
        <p>A playlist <strong>"${resultadoGerador.nomePlaylist}"</strong> foi gerada e populada no seu Spotify.</p>
        <a class="btn" href="${playlistUrl}" target="_blank">Abrir no Spotify</a>
      </div>
    `);

  } catch (error) {
    console.error('Erro detalhado no callback:', error);
    res.status(500).send('<h1>Erro no Processamento</h1><p>Ocorreu um problema ao gerar ou popular a playlist. Verifique o console do terminal para detalhes.</p>');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});