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
    .filter(t => t.artists.some(a => a.id === artista.id)) // só faixas em que a artista realmente participa
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

const ARTISTAS_DISTRATORES = [
  'Imagine Dragons', 'Dua Lipa', 'Bad Bunny', 'Billie Eilish',
  'Coldplay', 'Ariana Grande', 'Foo Fighters', 'Anitta',
  'The Weeknd', 'Olivia Rodrigo', 'Bruno Mars', 'Adele',
  'Arca', 'Sd Laika'
];

async function gerarPerguntaDiscografia(spotifyApiApp, dados) {
  const { artista, hits, deepCuts } = dados;
  const poolFaixasArtista = [...hits, ...deepCuts];
  if (poolFaixasArtista.length === 0) return null;

  const faixaCorreta = embaralhar(poolFaixasArtista)[0];

  const distratoresPossiveis = ARTISTAS_DISTRATORES.filter(
    nome => nome.toLowerCase() !== artista.name.toLowerCase()
  );
  const artistasEscolhidos = embaralhar(distratoresPossiveis);

  const nomesDistratores = [];
  for (const nomeDistrator of artistasEscolhidos) {
    if (nomesDistratores.length >= 3) break;
    try {
      const busca = await spotifyApiApp.searchTracks(`artist:${nomeDistrator}`, { limit: 5 });
      const faixas = busca.body.tracks.items;
      if (faixas.length > 0) {
        nomesDistratores.push(embaralhar(faixas)[0].name);
      }
    } catch (e) {
      // ignora falha individual e segue pro próximo distrator
    }
  }

  if (nomesDistratores.length < 2) return null;

  const opcoes = embaralhar([faixaCorreta.name, ...nomesDistratores.slice(0, 3)]);

  return {
    id: 'q_discografia',
    tipo: 'conhecimento',
    texto: `Qual dessas músicas faz parte da discografia de ${artista.name}?`,
    opcoes,
    respostaCorreta: opcoes.indexOf(faixaCorreta.name)
  };
}

/**
 * Gera o conjunto de perguntas: 3 de conhecimento (com gabarito) + 3 de gosto.
 */
async function gerarPerguntas(spotifyApiApp, dados) {
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
  const hitsDeAlbuns = hits.filter(t => 
    t.album?.album_type === 'album'
  );

  if (hits.length >= 1 && albunsEstudio.length >= 3) {
    const faixaAlvo = hitsDeAlbuns[0];
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

  const perguntaDiscografia = await gerarPerguntaDiscografia(spotifyApiApp, dados);
  if (perguntaDiscografia) conhecimento.push(perguntaDiscografia);

  if (artista.genres && artista.genres.length > 0) {
    const generosArtista = artista.genres.slice(0, 2);
    const generosGerais = ['pop', 'rock', 'hip-hop', 'eletrônica', 'r&b', 'indie', 'k-pop', 'mpb', 'sertanejo', 'funk'];
    const opcoesGenero = [...new Set([...generosArtista, ...embaralhar(generosGerais)])].slice(0, 4);

    gosto.push({
      id: 'q_genero',
      tipo: 'gosto',
      texto: 'Qual desses gêneros mais te agrada?',
      opcoes: opcoesGenero,
      valor: opcoesGenero // o valor é o próprio nome do gênero
    });
  }

  // NOVA: personalidade
  gosto.push({
    id: 'q_personalidade',
    tipo: 'gosto',
    texto: 'Você é uma pessoa...',
    opcoes: ['Extrovertida', 'Introvertida', 'Tímida', 'Anti-social (no bom sentido!)'],
    valor: ['extrovertida', 'introvertida', 'timida', 'antisocial']
  });

  // NOVA: tempo de fã
  gosto.push({
    id: 'q_tempo_fa',
    tipo: 'gosto',
    texto: `Há quanto tempo você acompanha ${artista.name}?`,
    opcoes: [
      'Desde o debut e nunca mais larguei!',
      'Durante o auge da carreira e continuei acompanhando',
      'Acompanhava mais antes, mas nem tanto hoje em dia',
      'Conheci recentemente, mas já sou fã!'
    ],
    valor: ['debut', 'auge', 'menos_hoje', 'recente']
  });

  // NOVA: ecletismo
  gosto.push({
    id: 'q_ecletico',
    tipo: 'gosto',
    texto: 'Você se considera eclético(a) musicalmente?',
    opcoes: [
      'Nem um pouco, só ouço o mesmo gênero',
      'Gosto de sair da minha zona de conforto',
      'Abro minha mente para novas experiências, mesmo não gostando',
      'Qualquer gênero me agrada, eu gosto de tudo'
    ],
    valor: ['fechado', 'zona_conforto', 'mente_aberta', 'qualquer_genero']
  });

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

  // --- Conhecimento (igual antes) ---
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

  const getValor = (id) => {
    const pergunta = perguntas.find(p => p.id === id);
    const indice = respostas[id];
    return pergunta?.valor?.[indice];
  };

  const respEra = getValor('q_era') || 'misto';
  const respPop = getValor('q_popularidade') || 'misto';
  const respVibe = getValor('q_vibe') || 'casual';
  const respPersonalidade = getValor('q_personalidade');
  const respTempoFa = getValor('q_tempo_fa');
  const respEcletico = getValor('q_ecletico');
  const respGenero = getValor('q_genero');

  // --- Combina q_era + q_tempo_fa num score de "época" ---
  let eraScore = 0;
  if (respEra === 'classico') eraScore += 1;
  if (respEra === 'recente') eraScore -= 1;
  if (respTempoFa === 'debut') eraScore += 1;
  if (respTempoFa === 'auge') eraScore += 0.5;
  if (respTempoFa === 'menos_hoje') eraScore += 0.5;
  if (respTempoFa === 'recente') eraScore -= 1;

  const eraFinal = eraScore > 0 ? 'classico' : eraScore < 0 ? 'recente' : 'misto';

  // --- Rótulos ---
  const rotulosEra = { classico: 'Clássico', recente: 'Atual', misto: 'Eclético' };
  const rotulosPop = { hits: 'dos Hits', raridades: 'das Raridades', misto: 'do Equilíbrio' };
  const rotulosVibe = { energia: '🔥', introspectivo: '🌙', casual: '☀️' };

  const tituloPerfil = `${rotulosVibe[respVibe]} Fã ${nivelFa} ${rotulosEra[eraFinal]} ${rotulosPop[respPop]}`;

  // --- Montagem da playlist (era + popularidade, igual antes, usando eraFinal) ---
  const filtrarPorEra = (lista) => {
    if (eraFinal === 'misto') return lista;
    return lista.filter(t => {
      const ano = t.albumAno || parseInt((t.album?.release_date || '').substring(0, 4)) || anoMediano;
      return eraFinal === 'classico' ? ano <= anoMediano : ano > anoMediano;
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

  // --- Bônus de raridade: conhecimento + ecletismo ---
  const bonusConhecimento = nivelFa === 'Hardcore' ? 4 : nivelFa === 'Dedicado' ? 2 : 0;
  const bonusEcletismo = { fechado: 0, zona_conforto: 1, mente_aberta: 2, qualquer_genero: 3 }[respEcletico] || 0;
  const bonusRaridade = bonusConhecimento + bonusEcletismo;

  if (bonusRaridade > 0) {
    candidatos = candidatos.concat(escolherDistintos(deepCuts, bonusRaridade, candidatos));
  }

  candidatos = candidatos.filter((t, i, self) => i === self.findIndex(x => x.id === t.id));
  candidatos = embaralhar(candidatos);

  // --- Ordenação pela personalidade: extrovertida = hits na frente, tímida/introvertida = raridades na frente ---
  if (respPersonalidade === 'extrovertida') {
    candidatos.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  } else if (respPersonalidade === 'introvertida' || respPersonalidade === 'timida') {
    candidatos.sort((a, b) => (a.popularity || 0) - (b.popularity || 0));
  }

  const faixasFinal = candidatos.slice(0, 15);

  const descricaoGenero = respGenero ? ` Combina com seu gosto por ${respGenero}.` : '';

  return {
    titulo: tituloPerfil,
    descricao: `Gerado pelo Quiz de ${artista.name} • Nível ${nivelFa} (${acertos}/${totalConhecimento} no conhecimento).${descricaoGenero}`,
    nomePlaylist: `${tituloPerfil} — ${artista.name}`,
    uris: faixasFinal.map(t => t.uri),
    faixas: candidatos.map(t => ({
      nome: t.name,
      album: t.albumNome || t.album?.name,
      id: t.id,
      spotifyUrl: t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`
    }))
  };
}

module.exports = { buscarDadosArtista, gerarPerguntas, gerarResultado };