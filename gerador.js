// Função auxiliar para embaralhar arrays
function embaralhar(array) {
  return array.sort(() => Math.random() - 0.5);
}

/**
 * Motor Principal de Geração de Playlist (Versão Corrigida)
 */
async function gerarListaFoco(spotifyApi, dados) {
  const { musicaFocoNome, totalStreams, artistasPermitidos, artistasBanidos } = dados;

  console.log(`\n[Motor] Iniciando geração para a música: "${musicaFocoNome}"`);

  // 1. BUSCAR A MÚSICA FOCO
  const buscaMusica = await spotifyApi.searchTracks(`track:${musicaFocoNome}`);
  if (buscaMusica.body.tracks.items.length === 0) {
    throw new Error('Música foco não encontrada no Spotify.');
  }
  
  const trackFoco = buscaMusica.body.tracks.items[0];
  const trackFocoUri = trackFoco.uri;
  const artistaPrincipalId = trackFoco.artists[0].id;

  console.log(`[Motor] Música foco encontrada: ${trackFoco.name} - ${trackFoco.artists[0].name}`);

  const totalMusicasIntervaloNecessarias = totalStreams * 2;
  let poolMusicasIntervalo = [];

  // 2. BUSCAR MÚSICAS DOS ARTISTAS PERMITIDOS (Usando searchTracks para evitar o erro 403)
  if (artistasPermitidos && artistasPermitidos.length > 0) {
    console.log('[Motor] Buscando faixas dos artistas permitidos...');
    for (const nomeArtista of artistasPermitidos) {
      // Em vez de puxar o TopTracks do artista direto (que dá o 403), buscamos faixas gerais associadas ao nome dele
      const buscaFaixasArtista = await spotifyApi.searchTracks(`artist:${nomeArtista}`, { limit: 10 });
      if (buscaFaixasArtista.body.tracks.items.length > 0) {
        poolMusicasIntervalo.push(...buscaFaixasArtista.body.tracks.items);
      }
    }
  }

  // 3. PLANO DE CONTINGÊNCIA: Se faltar faixas, busca artistas relacionados
  if (poolMusicasIntervalo.length < totalMusicasIntervaloNecessarias) {
    console.log('[Motor] Músicas permitidas insuficientes. Buscando artistas relacionados...');
    try {
      const relacionados = await spotifyApi.getArtistRelatedArtists(artistaPrincipalId);
      
      for (const artistaRelacionado of relacionados.body.artists.slice(0, 3)) {
        const buscaFaixasRelacionado = await spotifyApi.searchTracks(`artist:${artistaRelacionado.name}`);
        poolMusicasIntervalo.push(...buscaFaixasRelacionado.body.tracks.items);
      }
    } catch (e) {
      console.log('[Aviso] Não foi possível buscar artistas relacionados, usando faixas de intervalo padrão.');
      // Fallback super seguro: busca apenas o termo "Pop Hit" diretamente como texto simples
      const faixasPop = await spotifyApi.searchTracks('Pop Hits');
      poolMusicasIntervalo.push(...faixasPop.body.tracks.items);
    }
  }

  // 4. APLICAR FILTROS (Blacklist e remover a própria música foco)
  console.log('[Motor] Aplicando filtros de banimento...');
  const blacklistLetraMinuscula = artistasBanidos.map(a => a.toLowerCase().trim());

  let musicasIntervaloFiltradas = poolMusicasIntervalo.filter(track => {
    if (track.id === trackFoco.id) return false;

    const artistaBanido = track.artists.some(artista => 
      blacklistLetraMinuscula.includes(artista.name.toLowerCase().trim())
    );
    
    return !artistaBanido;
  });

  // Remover duplicatas
  musicasIntervaloFiltradas = musicasIntervaloFiltradas.filter((track, index, self) =>
    index === self.findIndex((t) => t.id === track.id)
  );

  // Embaralhar
  musicasIntervaloFiltradas = embaralhar(musicasIntervaloFiltradas);

  // 5. O ALGORITMO DE INTERCALAMENTO
  console.log('[Motor] Montando estrutura de intercalamento...');
  const playlistFinalUris = [];
  let indexIntervalo = 0;

  for (let i = 0; i < totalStreams; i++) {
    playlistFinalUris.push(trackFocoUri);

    for (let j = 0; j < 2; j++) {
      if (musicasIntervaloFiltradas.length > 0) {
        const trackIntervalo = musicasIntervaloFiltradas[indexIntervalo % musicasIntervaloFiltradas.length];
        playlistFinalUris.push(trackIntervalo.uri);
        indexIntervalo++;
      }
    }
  }

  console.log(`[Motor] Sucesso! Lista gerada com ${playlistFinalUris.length} faixas prontas.`);
  return {
    nomePlaylist: `Focus Stream: ${trackFoco.name}`,
    uris: playlistFinalUris
  };
}

module.exports = { gerarListaFoco };