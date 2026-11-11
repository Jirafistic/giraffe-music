'use strict';
// Idioma de la interfaz. "auto" sigue al del teléfono. Las palabras son las que usa
// YouTube Music en español, para que la app se sienta igual de familiar.
// Si el idioma es inglés, T() y L() devuelven lo mismo sin hacer nada (costo cero).
const LANG = (() => {
  let p = 'auto';
  try { p = JSON.parse(localStorage.getItem('gm.settings') || '{}').lang || 'auto'; } catch {}
  if (p === 'auto') p = /^es\b/i.test(navigator.language || '') ? 'es' : 'en';
  return p === 'es' ? 'es' : 'en';
})();
document.documentElement.lang = LANG;

const ES = LANG !== 'es' ? null : new Map(Object.entries({
  // navegación y estantes
  'Home': 'Principal', 'Samples': 'Samples', 'Explore': 'Explorar', 'Library': 'Biblioteca',
  'Quick picks': 'Selección rápida', 'Listen again': 'Volver a escuchar', 'Mixed for you': 'Mixes para ti',
  'Speed dial': 'Marcación rápida', 'Recommended albums': 'Álbumes recomendados', 'Recommended music videos': 'Videos musicales recomendados',
  'Forgotten favorites': 'Favoritos olvidados', 'From the community': 'De la comunidad', 'Long listening': 'Para escuchar un buen rato',
  'Trending': 'Tendencias', 'Charts': 'Listas de éxitos', 'New releases': 'Nuevos lanzamientos', 'Moods & genres': 'Estados de ánimo y géneros',
  'Top songs': 'Canciones más populares', 'Top result': 'Resultado principal', 'Featured on': 'Aparece en', 'Fans might also like': 'A los fans también les puede gustar',
  'Similar artists': 'Artistas similares', 'You might also like': 'También te puede gustar', 'Recently played': 'Reproducido recientemente',
  'Time capsule': 'Cápsula del tiempo', 'Featured playlists': 'Playlists destacadas', 'More from': 'Más de', 'Show all': 'Mostrar todo',
  'Hace un año escuchabas esto': 'Hace un año escuchabas esto', 'Hace un mes escuchabas esto': 'Hace un mes escuchabas esto',
  'Hace una semana escuchabas esto': 'Hace una semana escuchabas esto',
  'Energize': 'Energía', 'Relax': 'Relajarse', 'Feel good': 'Sentirse bien', 'Workout': 'Ejercicio', 'Commute': 'Trayecto', 'Focus': 'Concentración',
  'Party': 'Fiesta', 'Romance': 'Romance', 'Sad': 'Tristeza', 'Sleep': 'Dormir', 'Podcasts': 'Podcasts',
  // biblioteca
  'Playlists': 'Playlists', 'Songs': 'Canciones', 'Albums': 'Álbumes', 'Artists': 'Artistas', 'Downloads': 'Descargas', 'Videos': 'Videos',
  'Singles': 'Sencillos', 'Recent activity': 'Actividad reciente', 'Recently added': 'Agregados recientemente', 'Sort by': 'Ordenar por',
  'Liked Music': 'Música que te gusta', 'Auto playlist': 'Playlist automática', 'New': 'Nueva', 'Your library': 'Tu biblioteca',
  'Grid view': 'Vista de cuadrícula', 'List view': 'Vista de lista', 'A–Z': 'A-Z', 'Z–A': 'Z-A',
  'Nothing here yet': 'Todavía no hay nada aquí', 'No songs yet': 'Aún no hay canciones', 'No downloads yet': 'Aún no hay descargas',
  'No results in your library': 'No hay resultados en tu biblioteca', 'Songs you like will show up here.': 'Aquí aparecerán las canciones que te gusten.',
  'Songs you like or save show up here.': 'Aquí aparecen las canciones que te gustan o guardas.',
  'Save albums, playlists and artists to find them fast.': 'Guarda álbumes, playlists y artistas para encontrarlos rápido.',
  'Tap Download on a song, album or playlist to listen without internet.': 'Toca Descargar en una canción, álbum o playlist para escucharla sin internet.',
  'Sign in to see your playlists, albums and likes from YouTube Music.': 'Accede para ver tus playlists, álbumes y Me gusta de YouTube Music.',
  'On this device': 'En este dispositivo', 'Go to downloads': 'Ir a descargas', 'Open playlist': 'Abrir playlist',
  // listas y menús
  'Play': 'Reproducir', 'Play all': 'Reproducir todo', 'Shuffle': 'Aleatorio', 'Shuffle play': 'Reproducción aleatoria', 'Start radio': 'Iniciar radio',
  'Play next': 'Reproducir a continuación', 'Add to queue': 'Agregar a la fila', 'Save to library': 'Guardar en la biblioteca',
  'Remove from library': 'Quitar de la biblioteca', 'Save to playlist': 'Guardar en una playlist', 'Remove from playlist': 'Quitar de la playlist',
  'Remove from queue': 'Quitar de la fila', 'Go to album': 'Ir al álbum', 'Go to artist': 'Ir al artista', 'Share': 'Compartir',
  'Download': 'Descargar', 'Downloaded': 'Descargado', 'Remove download': 'Quitar descarga', 'Like': 'Me gusta', 'Dislike': 'No me gusta',
  'Remove from liked songs': 'Quitar de canciones que te gustan', 'Remove from search history': 'Quitar del historial de búsqueda',
  'Edit': 'Editar', 'Save': 'Guardar', 'Saved': 'Guardado', 'Subscribe': 'Suscribirse', 'Subscribed': 'Suscrito', 'More': 'Más',
  'Edit playlist': 'Editar playlist', 'New playlist': 'Nueva playlist', 'Playlist name': 'Nombre de la playlist', 'Title': 'Título',
  'Description (optional)': 'Descripción (opcional)', 'Description': 'Descripción', 'Visibility': 'Visibilidad', 'Public': 'Pública', 'Unlisted': 'No listada',
  'Private': 'Privada', 'Create': 'Crear', 'Cancel': 'Cancelar', 'Done': 'Listo', 'Close': 'Cerrar', 'Back': 'Atrás', 'Next': 'Siguiente',
  'Previous': 'Anterior', 'Retry': 'Reintentar', 'Clear': 'Borrar', 'Delete': 'Borrar', 'Later': 'Más tarde', 'Update': 'Actualizar',
  'Keep current visibility': 'Mantener la visibilidad actual', 'Move': 'Mover', 'Undo': 'Deshacer', 'Enter': 'Entrar', 'You': 'Tú',
  // reproductor
  'Song': 'Canción', 'Video': 'Video', 'Up next': 'A continuación', 'Lyrics': 'Letra', 'Related': 'Relacionado', 'Queue': 'Fila',
  'Playing from': 'Reproduciendo desde', 'Autoplay': 'Reproducción automática', 'Add similar content to the end of the queue': 'Agrega contenido similar al final de la fila',
  'Repeat': 'Repetir', 'Repeat all': 'Repetir todo', 'Repeat one': 'Repetir una', 'Repeat off': 'Repetición desactivada',
  'Shuffle on': 'Aleatorio activado', 'Shuffle off': 'Aleatorio desactivado', 'Play/Pause': 'Reproducir/Pausar', 'Cast': 'Transmitir',
  'Sleep timer': 'Temporizador', 'Sleep timer (on)': 'Temporizador (activado)', 'Sleep timer off': 'Temporizador desactivado', 'Turn off timer': 'Desactivar temporizador',
  'End of song': 'Final de la canción', 'Lyrics from LRCLIB': 'Letra de LRCLIB', "Lyrics aren't available": 'La letra no está disponible',
  "We couldn't find lyrics for this song.": 'No encontramos la letra de esta canción.', 'Romanize': 'Pronunciación', 'Showing pronunciation': 'Mostrando la pronunciación',
  'Original lyrics only': 'Solo la letra original', 'Nothing related found.': 'No se encontró nada relacionado.', 'Video is off while Data saver is on': 'El video está desactivado con el Ahorro de datos',
  'Skipped a non-music part': 'Se saltó una parte sin música', "Couldn't play this song": 'No se pudo reproducir esta canción',
  'Use your phone’s Quick Settings to cast audio': 'Usa la Configuración rápida del teléfono para transmitir audio', 'No devices found': 'No se encontraron dispositivos',
  // búsqueda
  'Search': 'Buscar', 'Search songs, artists, albums': 'Busca canciones, artistas, álbumes', 'Voice': 'Voz', 'Artist': 'Artista', 'Album': 'Álbum',
  'Single': 'Sencillo', 'EP': 'EP', 'Playlist': 'Playlist', 'Episode': 'Episodio', 'Profile': 'Perfil', 'From lyrics': 'Por la letra',
  // cuenta
  'Account': 'Cuenta', 'Your channel': 'Tu canal', 'History': 'Historial', 'Settings': 'Configuración', 'Help & feedback': 'Ayuda y comentarios',
  'YouTube account': 'Cuenta de YouTube', 'Manage your Google Account': 'Administra tu Cuenta de Google', 'Sign in': 'Acceder',
  'Sign in to YouTube Music': 'Accede a YouTube Music', 'Not signed in': 'No accediste', 'Sign out': 'Salir', 'Signed out': 'Saliste de tu cuenta',
  'Signing in…': 'Accediendo…', 'Signed in with Google': 'Accediste con Google', 'Privacy Policy': 'Política de Privacidad', 'Terms of Service': 'Condiciones del Servicio',
  'Get your playlists, likes, history and recommendations from YouTube Music.': 'Trae tus playlists, Me gusta, historial y recomendaciones de YouTube Music.',
  'Giraffe Music · no ads, ever': 'Giraffe Music · sin anuncios, nunca',
  // configuración
  'General': 'General', 'Playback & restrictions': 'Reproducción y restricciones', 'Data saving': 'Ahorro de datos', 'Downloads & storage': 'Descargas y almacenamiento',
  'Privacy & data': 'Privacidad y datos', 'Transfer from Spotify': 'Transferir desde Spotify', 'About': 'Información', 'Language': 'Idioma',
  'System default': 'Predeterminado del sistema', 'English': 'English', 'Español': 'Español', 'Restart Giraffe Music to change the language': 'El idioma cambia al volver a abrir Giraffe Music',
  'Square thumbnails': 'Miniaturas cuadradas', 'Show every thumbnail in lists as a square, videos too': 'Muestra todas las miniaturas de las listas en cuadrado, también las de videos',
  'Swipe to change songs': 'Deslizar para cambiar de canción', 'Swipe the artwork left or right in the player to skip or go back': 'Desliza la carátula a la izquierda o la derecha para saltar o volver',
  'Keep playing similar songs when your queue ends': 'Sigue reproduciendo canciones similares cuando termina la fila', 'Skip non-music parts': 'Omitir partes sin música',
  'Skip talking and sponsor breaks in music videos (SponsorBlock)': 'Omite charlas y patrocinios en los videos musicales (SponsorBlock)',
  'Normalize volume': 'Normalizar el volumen', 'Set the same volume level for all songs': 'Establece el mismo nivel de volumen para todas las canciones',
  'Resume with headphones': 'Reanudar con auriculares', 'Resume playback when headphones are connected': 'Reanuda la reproducción al conectar los auriculares',
  'Equalizer': 'Ecualizador', 'Dolby Atmos': 'Dolby Atmos', 'Data saver': 'Ahorro de datos', 'Smaller artwork and no music videos': 'Carátulas más chicas y sin videos musicales',
  'Audio quality on Wi-Fi': 'Calidad del audio en Wi-Fi', 'Audio quality on mobile network': 'Calidad del audio en la red móvil',
  'Low': 'Baja', 'Normal': 'Normal', 'High': 'Alta', 'Always high': 'Siempre alta', 'Auto': 'Automática', 'Auto (recommended)': 'Automática (recomendada)',
  'Uses less data': 'Usa menos datos', 'Uses more data': 'Usa más datos', 'Adjusts to your connection': 'Se adapta a tu conexión', 'Best audio quality': 'La mejor calidad de audio',
  'Download over Wi-Fi only': 'Descargar solo con Wi-Fi', 'Downloads are set to Wi-Fi only': 'Las descargas son solo con Wi-Fi', 'Download now': 'Descargar ahora',
  'Delete all downloads': 'Borrar todas las descargas', 'Delete all downloads?': '¿Borrar todas las descargas?', 'Downloads deleted': 'Se borraron las descargas',
  'Storage': 'Almacenamiento', 'Audio, artwork and lyrics. Only playable in Giraffe Music.': 'Audio, carátula y letra. Solo se reproducen en Giraffe Music.',
  'Search history': 'Historial de búsqueda', 'Clear search history': 'Borrar historial de búsqueda', 'Clear listening history': 'Borrar historial de reproducciones',
  'Search history cleared': 'Se borró el historial de búsqueda', 'History cleared': 'Se borró el historial', 'Synced with your YouTube Music account': 'Sincronizado con tu cuenta de YouTube Music',
  'Sign in to sync your searches with YouTube Music': 'Accede para sincronizar tus búsquedas con YouTube Music', 'Check for updates': 'Buscar actualizaciones',
  'Source code': 'Código fuente', 'Web player': 'Reproductor web', 'Battery': 'Batería', 'Paste a Spotify playlist link': 'Pega el enlace de una playlist de Spotify',
  'Copy your Spotify playlists to YouTube Music': 'Copia tus playlists de Spotify a YouTube Music', 'Reading the Spotify playlist…': 'Leyendo la playlist de Spotify…',
  'Creating your playlist…': 'Creando tu playlist…', 'Update available': 'Actualización disponible', 'Bug fixes and improvements.': 'Correcciones de errores y mejoras.',
  'Installing…': 'Instalando…', 'Downloading update…': 'Descargando la actualización…', 'Updates are not set up in this build': 'Las actualizaciones no están configuradas en esta versión',
  'Allow Giraffe Music to install updates, then tap Update again': 'Permite que Giraffe Music instale actualizaciones y vuelve a tocar Actualizar',
  "Couldn't check for updates": 'No se pudo buscar actualizaciones', "Couldn't download the update": 'No se pudo descargar la actualización',
  // avisos
  'Saved to library': 'Se guardó en la biblioteca', 'Removed from library': 'Se quitó de la biblioteca', 'Saved to Liked Music': 'Se guardó en Música que te gusta',
  'Removed from Liked Music': 'Se quitó de Música que te gusta', 'Saved to playlist': 'Se guardó en la playlist', 'Removed from playlist': 'Se quitó de la playlist',
  'Removed from queue': 'Se quitó de la fila', 'Removed from downloads': 'Se quitó de las descargas', 'Removed from search history': 'Se quitó del historial de búsqueda',
  'Song added to queue': 'Se agregó la canción a la fila', 'Song will play next': 'La canción se reproducirá a continuación', 'Link copied': 'Se copió el vínculo',
  'Downloading…': 'Descargando…', 'Already downloaded': 'Ya está descargada', 'Remove this song from downloads?': '¿Quitar esta canción de las descargas?',
  'Something went wrong': 'Se produjo un error', "You're offline": 'No tienes conexión', 'Listen to your downloads while you reconnect.': 'Escucha tus descargas mientras vuelves a conectarte.',
  'My playlist': 'Mi playlist', 'Nueva playlist': 'Nueva playlist', 'Nothing played yet.': 'Todavía no reprodujiste nada.',
  // 0.4.0
  'Listen together': 'Escuchar juntos', 'Join': 'Unirse', 'Scan QR code': 'Escanear código QR', 'Enter code': 'Ingresa el código',
  'Share this code or QR with up to 3 people on your Wi-Fi': 'Comparte este código o QR con hasta 3 personas en tu Wi-Fi',
  'Ask for the code of the person who created the session': 'Pide el código a la persona que creó la sesión', 'Leave': 'Salir', 'End session': 'Terminar sesión',
  'You left the session': 'Saliste de la sesión', 'Session ended': 'La sesión terminó', "Couldn't join. Check the code and that you're on the same Wi-Fi": 'No se pudo unir. Revisa el código y que estén en el mismo Wi-Fi',
  'Joining…': 'Uniéndote…',
  'Only the host can change the music': 'Solo el anfitrión puede cambiar la música', 'You can now change the music': 'Ahora puedes cambiar la música',
  'The host let you change the music.': 'El anfitrión te dio permiso para cambiar la música.',
  'You are listening along. Only the host can change the music.': 'Están escuchando juntos. Solo el anfitrión puede cambiar la música.',
  'Hosts can change the music. Guests can only listen.': 'Los anfitriones pueden cambiar la música. Los invitados solo escuchan.',
  'Interface': 'Interfaz', 'Old': 'Clásica', 'New: like the latest YouTube Music': 'Nueva: como el último YouTube Music',
  'Old: the classic Giraffe Music': 'Clásica: la de siempre de Giraffe Music', 'Restarting…': 'Reiniciando…',
  'Search in this playlist': 'Buscar en esta playlist', 'Search for it in all of Giraffe Music?': '¿Buscarla en todo Giraffe Music?', 'Add': 'Agregar',
  "This song wasn't found. It can't be played or downloaded": 'No se encontró esta canción. No se puede escuchar ni descargar',
  '1 song wasn’t found': 'No se encontró 1 canción', 'Keep': 'Dejarlas', 'Remove': 'Quitar', "Couldn't remove some songs": 'No se pudieron quitar algunas canciones',
  'Removed 1 song from the playlist': 'Se quitó 1 canción de la playlist',
  'Host': 'Anfitrión', 'Guest': 'Invitado', 'Person': 'Persona', 'Show code': 'Mostrar código', 'Create': 'Crear', 'This session is full': 'Esta sesión está llena',
  'You are listening along. Anyone can play, pause or change the song.': 'Están escuchando juntos. Cualquiera puede reproducir, pausar o cambiar la canción.',
  "Couldn't open the camera. Type the code instead": 'No se pudo abrir la cámara. Escribe el código', 'This QR is not from Giraffe Music': 'Este QR no es de Giraffe Music', 'Connect to Wi-Fi to listen together': 'Conéctate a una red Wi-Fi para escuchar juntos',
  'Allow camera access to scan the code': 'Permite el acceso a la cámara para escanear el código', 'Point the camera at the QR code': 'Apunta la cámara al código QR',
  "What's new": 'Novedades', 'Got it': 'Entendido', 'Move your playlists to your account?': '¿Pasar tus playlists a tu cuenta?',
  'Not now': 'Ahora no', 'Moving your playlists…': 'Pasando tus playlists…', 'Your playlists are in your account': 'Tus playlists ya están en tu cuenta',
  'Saved on this device': 'Guardada en este dispositivo',
  'When you sign in, you can move it to your YouTube account.': 'Cuando accedas, podrás pasarla a tu cuenta de YouTube.',
  'They will be saved as private playlists in your YouTube Music library, on all your devices.': 'Se guardarán como playlists privadas en tu biblioteca de YouTube Music, en todos tus dispositivos.',
  "Couldn't move some playlists. Try again later": 'No se pudieron pasar algunas playlists. Vuelve a intentarlo más tarde',
  'Delete playlist': 'Borrar playlist', "The title can't be empty": 'El título no puede estar vacío', "Couldn't save the changes": 'No se pudieron guardar los cambios',
  "Couldn't create the playlist": 'No se pudo crear la playlist', "Couldn't save to that playlist": 'No se pudo guardar en esa playlist', "Couldn't remove it": 'No se pudo quitar',
  "Couldn't sign in. Try again.": 'No se pudo acceder. Vuelve a intentarlo.', 'Open': 'Abrir', 'Transfer': 'Transferir',
  'Albums for you': 'Álbumes para ti', 'Recommended artists': 'Artistas recomendados', 'New albums & singles': 'Nuevos álbumes y sencillos', 'Moods & genres': 'Estados de ánimo y géneros',
  'START RADIO FROM A SONG': 'INICIA UNA RADIO DESDE UNA CANCIÓN', 'Start radio from a song': 'Inicia una radio desde una canción',
  "Downloads wait for Wi-Fi so they don't use your mobile data": 'Las descargas esperan al Wi-Fi para no usar tus datos móviles',
  'Keep playing when you connect Bluetooth or wired headphones (up to 30 min after pausing)': 'Sigue reproduciendo al conectar auriculares Bluetooth o con cable (hasta 30 min después de pausar)',
  'Native player with audio offload, a 256 MB audio cache and nothing running in the background.': 'Reproductor nativo con audio por hardware, caché de audio de 256 MB y nada corriendo en segundo plano.',
  'No ads, ever. Built on the ytm-rs core (GPL-3.0).': 'Sin anuncios, nunca. Hecho sobre el núcleo de ytm-rs (GPL-3.0).',
  'On this device. Long-press a past search to remove it from your account.': 'En este dispositivo. Mantén presionada una búsqueda para quitarla de tu cuenta.',
  'On this device. Your YouTube history stays in your account.': 'En este dispositivo. Tu historial de YouTube queda en tu cuenta.',
  'On this device': 'En este dispositivo',
  'Paste a public Spotify playlist link. Giraffe finds each song on YouTube Music and saves them as a new private playlist in your library.': 'Pega el enlace de una playlist pública de Spotify. Giraffe busca cada canción en YouTube Music y las guarda en una playlist privada nueva en tu biblioteca.',
  "Adjust the sound with your phone's equalizer. Sound effects use a bit more battery.": 'Ajusta el sonido con el ecualizador del teléfono. Los efectos de sonido usan un poco más de batería.',
  "Open your phone's Dolby Atmos settings": 'Abre la configuración de Dolby Atmos del teléfono',
  'Demo account': 'Cuenta de demostración', 'Chart': 'Lista', 'Replay Mix': 'Replay Mix', 'Top 100 Songs Global': 'Top 100 canciones global',
  'Top 100 Music Videos': 'Top 100 videos musicales', 'Account': 'Cuenta',
  'New albums &amp; singles': 'Nuevos álbumes y sencillos', 'Moods &amp; genres': 'Estados de ánimo y géneros',
  'Sign in so Giraffe can create the playlist in your YouTube Music library.': 'Accede para que Giraffe pueda crear la playlist en tu biblioteca de YouTube Music.',
}));

// Textos con números u otras partes que cambian.
const ES_RULES = LANG !== 'es' ? [] : [
  [/^1 songs?$/, '1 canción'], [/^([\d.,]+[KMB]?) songs$/, '$1 canciones'], [/^1 tracks?$/, '1 canción'], [/^([\d.,]+) tracks$/, '$1 canciones'],
  [/^([\d.,]+[KMB]?) views$/, '$1 vistas'], [/^([\d.,]+[KMB]?) plays$/, '$1 reproducciones'], [/^([\d.,]+[KMB]?) subscribers$/, '$1 suscriptores'],
  [/^([\d.,]+[KMB]?) monthly audience$/, '$1 de público mensual'], [/^(\d+) hours?$/, '$1 h'], [/^(\d+) minutes?$/, '$1 min'],
  [/^(\d+) hr (\d+) min$/, '$1 h $2 min'], [/^(\d+) min$/, '$1 min'], [/^(\d+) songs, (.*)$/, '$1 canciones, $2'],
  [/^Downloading (\d+) songs$/, 'Descargando $1 canciones'], [/^Downloaded (\d+) songs$/, 'Se descargaron $1 canciones'], [/^Downloaded “(.*)”$/, 'Se descargó “$1”'],
  [/^(\d+) songs will play next$/, 'Se reproducirán $1 canciones a continuación'], [/^(\d+) songs added to queue$/, 'Se agregaron $1 canciones a la fila'],
  [/^Saved (\d+) songs to library$/, 'Se guardaron $1 canciones en la biblioteca'], [/^Saved to “(.*)”$/, 'Se guardó en “$1”'], [/^Created “(.*)”$/, 'Se creó “$1”'],
  [/^Music will stop in (\d+) minutes$/, 'La música se detendrá en $1 minutos'], [/^No results for “(.*)”$/, 'No hay resultados para “$1”'],
  [/^You're on the latest version \((.*)\)$/, 'Tienes la última versión ($1)'], [/^Version (.*)$/, 'Versión $1'], [/^Downloading update… (\d+)%$/, 'Descargando la actualización… $1%'],
  [/^Signed in as (.*)$/, 'Accediste como $1'], [/^(\d+) minutes$/, '$1 minutos'], [/^Connected · (\d+) of (\d+)$/, 'Conectados · $1 de $2'],
  [/^Song • (.*)$/, 'Canción • $1'], [/^Video • (.*)$/, 'Video • $1'], [/^Artist • (.*)$/, 'Artista • $1'], [/^Album • (.*)$/, 'Álbum • $1'],
  [/^Single • (.*)$/, 'Sencillo • $1'], [/^Playlist • (.*)$/, 'Playlist • $1'], [/^(\d+) of (\d+) songs saved to “(.*)”$/, '$1 de $2 canciones guardadas en “$3”'],
  [/^Finding songs on YouTube Music… (\d+) of (\d+)$/, 'Buscando canciones en YouTube Music… $1 de $2'], [/^Not found \((\d+)\):$/, 'No se encontraron ($1):'],
  [/^Not in this playlist: “(.*)”$/, 'No está en esta playlist: “$1”'], [/^Adding to “(.*)”$/, 'Agregando a “$1”'],
  [/^“(.*)” wasn't found$/, 'No se encontró “$1”'], [/^(\d+) songs weren’t found$/, 'No se encontraron $1 canciones'],
  [/^(\d+) songs weren't found and were skipped$/, 'No se encontraron $1 canciones y se saltearon'], [/^Removed (\d+) songs from the playlist$/, 'Se quitaron $1 canciones de la playlist'],
  [/^YouTube no longer has them \(deleted or private\), so they can't be downloaded or played\. Remove them from “(.*)”\?$/, 'YouTube ya no las tiene (se borraron o son privadas), así que no se pueden descargar ni escuchar. ¿Quitarlas de “$1”?'],
  [/^(.*) Radio$/, 'Radio de $1'], [/^(.*) and more$/, '$1 y más'], [/^Top 100 Songs (.*)$/, 'Top 100 canciones $1'], [/^Trending 20 (.*)$/, 'Tendencias 20 $1'],
  [/^(.*) free on this device$/, '$1 libres en este dispositivo'],
  [/^Only playable inside Giraffe Music\. Audio, artwork and lyrics are kept in the app's private storage \((.*) free\)\.$/, 'Solo se reproduce dentro de Giraffe Music. El audio, la carátula y la letra se guardan en el almacenamiento privado de la app ($1 libres).'], [/^(\d+) of (\d+)$/, '$1 de $2'],
];

/** Traduce un texto de la interfaz (o lo devuelve igual si no hay traducción). */
function T(s) {
  if (!ES || !s) return s;
  const k = String(s).trim();
  if (!k) return s;
  const r = ES.get(k);
  if (r != null) return s === k ? r : String(s).replace(k, r);
  if (k.includes(' • ')) {
    const parts = k.split(' • '), out = parts.map((p) => T(p));
    if (out.some((p, i) => p !== parts[i])) return String(s).replace(k, out.join(' • '));
  }
  for (const [re, to] of ES_RULES) if (re.test(k)) return String(s).replace(k, k.replace(re, to));
  return s;
}
/** Traduce el HTML que arma la interfaz: los textos entre etiquetas y las etiquetas de
 *  accesibilidad. Solo se toca lo que coincide exacto con el diccionario. */
function L(html) {
  if (!ES || !html) return html;
  return String(html)
    .replace(/>([^<>]+)</g, (m, t) => (/[A-Za-z]/.test(t) ? '>' + T(t) + '<' : m))
    .replace(/(placeholder|aria-label)="([^"]+)"/g, (m, a, t) => `${a}="${T(t)}"`);
}
// Lo que ya viene escrito en index.html.
if (ES) document.addEventListener('DOMContentLoaded', () => {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) if (/[A-Za-z]/.test(n.nodeValue)) n.nodeValue = T(n.nodeValue);
  for (const el of document.querySelectorAll('[aria-label],[placeholder]')) {
    for (const a of ['aria-label', 'placeholder']) if (el.hasAttribute(a)) el.setAttribute(a, T(el.getAttribute(a)));
  }
}, { once: true });
