// Função auxiliar para embaralhar arrays
function embaralhar(array) {
  return [...array].sort(() => Math.random() - 0.5);
}

function escolherDistintos(array, n, excluirIds = []) {
  const pool = array.filter(item => !excluirIds.includes(item.id));
  return embaralhar(pool).slice(0, n);
}

/**
 * Busca os dados do artista necessários para montar o quiz e a playlist.
 * Usa um token de App (Client Credentials), não precisa de login do usuário.
 */
async function buscarTodosAlbuns(spotifyApiApp, artistaId, limitePorPagina = 10, maxAlbuns = 30) {
  let albuns = [];
  let offset = 0;

  while (albuns.length < maxAlbuns) {
    const resp = await spotifyApiApp.getArtistAlbums(artistaId, {
      include_groups: 'album,single',
      limit: limitePorPagina,
      offset
    });

    albuns.push(...resp.body.items);

    // Se não tem próxima página ou veio vazio, para
    if (!resp.body.next || resp.body.items.length === 0) break;

    offset += limitePorPagina;
  }

  return albuns.slice(0, maxAlbuns);
}

async function buscarDadosArtista(spotifyApiApp, nomeArtista) {
  console.log('[Quiz] Buscando artista:', nomeArtista);
  const buscaArtista = await spotifyApiApp.searchArtists(nomeArtista, { limit: 10 });
  const resultados = buscaArtista.body.artists.items;
  
  if (resultados.length === 0) {
    throw new Error('Artista não encontrado no Spotify.');
  }
  
  // Prioriza um match EXATO de nome (ignorando maiúsculas/minúsculas)
  const nomeNormalizado = nomeArtista.trim().toLowerCase();
  let artista = resultados.find(a => a.name.toLowerCase() === nomeNormalizado);
  
  // Se não houver match exato, usa o mais popular entre os resultados
  if (!artista) {
    artista = [...resultados].sort((a, b) => b.popularity - a.popularity)[0];
  }
  console.log('[Quiz] Artista encontrado:', artista.name, artista.id);

  console.log('[Quiz] Buscando faixas populares via search...');
  const buscaFaixas = await spotifyApiApp.searchTracks(`artist:${artista.name}`, { limit: 10 });
  
  // Filtra só faixas onde o artista é realmente um dos artistas (evita falsos positivos do search)
  const faixasDoArtista = buscaFaixas.body.tracks.items.filter(t =>
    t.artists.some(a => a.id === artista.id)
  );
  
  // Ordena por popularidade e pega as 10 mais populares como "hits"
  const hits = [...faixasDoArtista]
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 10);
  
  console.log('[Quiz] Top tracks (via search) OK:', hits.length);

  console.log('[Quiz] Buscando álbuns...');
  const albunsResp = await spotifyApiApp.getArtistAlbums(artista.id, {
    include_groups: 'album,single',
    limit: 10
  });
  const todosAlbuns = await buscarTodosAlbuns(spotifyApiApp, artista.id, 10, 30);
  console.log('[Quiz] Álbuns OK:', albunsResp.body.items.length);

  // ... resto continua igual

  // Remove duplicatas (deluxe, remasters etc. com mesmo nome)
  const albunsUnicos = [];
  const nomesVistos = new Set();
  for (const album of todosAlbuns) {
    const chave = album.name.toLowerCase().trim();
    if (!nomesVistos.has(chave)) {
      nomesVistos.add(chave);
      albunsUnicos.push(album);
    }
  }

  const albunsEstudio = albunsUnicos.filter(a => a.album_type === 'album');

  // Busca faixas de até 6 álbuns de estúdio aleatórios pra montar o pool de "raridades"
  const idsHits = new Set(hits.map(t => t.id));
  const albunsParaFaixas = embaralhar(albunsEstudio).slice(0, 6);
  let deepCuts = [];

  for (const album of albunsParaFaixas) {
    const faixasResp = await spotifyApiApp.getAlbumTracks(album.id, { limit: 50 });
    const faixas = faixasResp.body.items
      .filter(t => !idsHits.has(t.id))
      .map(t => ({
        ...t,
        albumNome: album.name,
        albumAno: parseInt(album.release_date.substring(0, 4)) || null
      }));
    deepCuts.push(...faixas);
  }

  // Remove duplicatas
  deepCuts = deepCuts.filter((t, i, self) => i === self.findIndex(x => x.id === t.id));

  // Ano "mediano" da discografia, usado pra dividir clássico vs recente
  const anos = albunsEstudio
    .map(a => parseInt(a.release_date.substring(0, 4)))
    .sort((a, b) => a - b);
  const anoMediano = anos.length > 0 ? anos[Math.floor(anos.length / 2)] : new Date().getFullYear();

  return { artista, hits, albuns: albunsUnicos, albunsEstudio, deepCuts, anoMediano };
}

/**
 * Gera o conjunto de perguntas: 3 de conhecimento (com gabarito) + 3 de gosto.
 */
function gerarPerguntas(dados) {
  const { artista, hits, albunsEstudio } = dados;
  const conhecimento = [];
  const gosto = [];

  // 1. Ano de lançamento de um álbum
  if (albunsEstudio.length >= 3) {
    const albumAlvo = embaralhar(albunsEstudio)[0];
    const anoCorreto = parseInt(albumAlvo.release_date.substring(0, 4));
    const outrosAnos = [...new Set(
      albunsEstudio.map(a => parseInt(a.release_date.substring(0, 4))).filter(a => a !== anoCorreto)
    )];
    const distratores = embaralhar(outrosAnos).slice(0, 3);
    while (distratores.length < 3) distratores.push(anoCorreto + distratores.length + 1);

    const opcoes = embaralhar([anoCorreto, ...distratores].map(String));
    conhecimento.push({
      id: 'q_ano_album',
      tipo: 'conhecimento',
      texto: `Em que ano foi lançado o álbum "${albumAlvo.name}"?`,
      opcoes,
      respostaCorreta: opcoes.indexOf(String(anoCorreto))
    });
  }

  // 2. Álbum de uma faixa popular
  if (hits.length >= 1 && albunsEstudio.length >= 3) {
    const faixaAlvo = hits[0];
    const albumCorreto = faixaAlvo.album.name;
    const outrosAlbuns = albunsEstudio.map(a => a.name).filter(n => n !== albumCorreto);
    const distratores = embaralhar([...new Set(outrosAlbuns)]).slice(0, 3);
    const opcoes = embaralhar([albumCorreto, ...distratores]);

    conhecimento.push({
      id: 'q_album_faixa',
      tipo: 'conhecimento',
      texto: `De qual álbum é a faixa "${faixaAlvo.name}"?`,
      opcoes,
      respostaCorreta: opcoes.indexOf(albumCorreto)
    });
  }

  // 3. Quantidade de álbuns de estúdio
  if (albunsEstudio.length >= 1) {
    const totalCorreto = albunsEstudio.length;
    const distratoresBase = [totalCorreto - 2, totalCorreto - 1, totalCorreto + 1, totalCorreto + 2]
      .filter(n => n > 0 && n !== totalCorreto);
    const opcoes = embaralhar([totalCorreto, ...embaralhar(distratoresBase).slice(0, 3)].map(String));

    conhecimento.push({
      id: 'q_total_albuns',
      tipo: 'conhecimento',
      texto: `Quantos álbuns de estúdio ${artista.name} já lançou (segundo o Spotify)?`,
      opcoes,
      respostaCorreta: opcoes.indexOf(String(totalCorreto))
    });
  }

  // --- Perguntas de gosto (fixas, mas personalizadas com o nome do artista) ---

  gosto.push({
    id: 'q_era',
    tipo: 'gosto',
    texto: `Quando o assunto é ${artista.name}, você prefere...`,
    opcoes: [
      'Os clássicos de sempre, do início da carreira',
      'O som mais atual, dos lançamentos recentes',
      'Um pouco dos dois, sem preferência fixa'
    ],
    valor: ['classico', 'recente', 'misto']
  });

  gosto.push({
    id: 'q_popularidade',
    tipo: 'gosto',
    texto: 'No Spotify, seu estilo de fã é mais...',
    opcoes: [
      'Toco os hits que todo mundo já conhece',
      'Adoro garimpar faixas raras que poucos ouvem',
      'Misturo hits com descobertas'
    ],
    valor: ['hits', 'raridades', 'misto']
  });

  gosto.push({
    id: 'q_vibe',
    tipo: 'gosto',
    texto: `O que você busca quando coloca ${artista.name} pra tocar?`,
    opcoes: [
      'Energia pra cantar e dançar junto',
      'Algo introspectivo, pra refletir',
      'Trilha sonora pro dia a dia, sem pensar muito'
    ],
    valor: ['energia', 'introspectivo', 'casual']
  });

  return [...embaralhar(conhecimento), ...embaralhar(gosto)];
}

/**
 * Calcula o perfil do fã e monta a playlist personalizada.
 */
function gerarResultado(dados, perguntas, respostas) {
  const { artista, hits, deepCuts, anoMediano } = dados;

  // --- Pontuação de conhecimento ---
  let acertos = 0;
  let totalConhecimento = 0;
  for (const pergunta of perguntas) {
    if (pergunta.tipo === 'conhecimento') {
      totalConhecimento++;
      if (respostas[pergunta.id] === pergunta.respostaCorreta) acertos++;
    }
  }

  let nivelFa;
  if (totalConhecimento > 0 && acertos === totalConhecimento) nivelFa = 'Hardcore';
  else if (acertos >= Math.ceil(totalConhecimento / 2)) nivelFa = 'Dedicado';
  else nivelFa = 'Iniciante';

  // --- Eixos de gosto ---
  const getValor = (id) => {
    const pergunta = perguntas.find(p => p.id === id);
    const indice = respostas[id];
    return pergunta?.valor?.[indice] || 'misto';
  };

  const respEra = getValor('q_era');
  const respPop = getValor('q_popularidade');
  const respVibe = getValor('q_vibe');

  const rotulosEra = { classico: 'Clássico', recente: 'Atual', misto: 'Eclético' };
  const rotulosPop = { hits: 'dos Hits', raridades: 'das Raridades', misto: 'do Equilíbrio' };
  const rotulosVibe = { energia: '🔥', introspectivo: '🌙', casual: '☀️' };

  const tituloPerfil = `${rotulosVibe[respVibe]} Fã ${nivelFa} ${rotulosEra[respEra]} ${rotulosPop[respPop]}`;

  // --- Montagem da playlist ---
  const filtrarPorEra = (lista) => {
    if (respEra === 'misto') return lista;
    return lista.filter(t => {
      const ano = t.albumAno || parseInt((t.album?.release_date || '').substring(0, 4)) || anoMediano;
      return respEra === 'classico' ? ano <= anoMediano : ano > anoMediano;
    });
  };

  let poolPrincipal, poolSecundario;
  if (respPop === 'hits') {
    poolPrincipal = hits;
    poolSecundario = deepCuts;
  } else if (respPop === 'raridades') {
    poolPrincipal = deepCuts;
    poolSecundario = hits;
  } else {
    poolPrincipal = embaralhar([...hits, ...deepCuts]);
    poolSecundario = [];
  }

  let candidatos = filtrarPorEra(poolPrincipal);
  if (candidatos.length < 8) candidatos = candidatos.concat(filtrarPorEra(poolSecundario));
  if (candidatos.length < 8) candidatos = candidatos.concat(poolPrincipal, poolSecundario);

  // Fãs mais conhecedores ganham faixas extras "raras" na mistura
  const bonusRaridade = nivelFa === 'Hardcore' ? 4 : nivelFa === 'Dedicado' ? 2 : 0;
  if (bonusRaridade > 0) {
    candidatos = candidatos.concat(escolherDistintos(deepCuts, bonusRaridade, candidatos));
  }

  candidatos = candidatos.filter((t, i, self) => i === self.findIndex(x => x.id === t.id));
  candidatos = embaralhar(candidatos).slice(0, 15);

  return {
    titulo: tituloPerfil,
    descricao: `Gerado pelo Quiz de ${artista.name} • Nível ${nivelFa} (${acertos}/${totalConhecimento} no conhecimento)`,
    nomePlaylist: `${tituloPerfil} — ${artista.name}`,
    uris: candidatos.map(t => t.uri),
    faixas: candidatos.map(t => ({ nome: t.name, album: t.albumNome || t.album?.name }))
  };
}

module.exports = { buscarDadosArtista, gerarPerguntas, gerarResultado };