const ICONS = {
  folder: '📁',
  video: '🎬',
  image: '🖼️',
  audio: '🎵',
  archive: '📦',
  document: '📄',
  app: '⚙️',
  code: '💻',
  other: '📃',
};

const CAT_META = {
  video: { label: 'Videolar', color: '#0078d4', icon: '🎬' },
  image: { label: 'Fotoğraflar', color: '#00b7c3', icon: '🖼️' },
  archive: { label: 'Arşivler & ISO', color: '#ca5010', icon: '📦' },
  document: { label: 'Belgeler', color: '#10893e', icon: '📄' },
  audio: { label: 'Ses', color: '#8764b8', icon: '🎵' },
  app: { label: 'Uygulamalar', color: '#e3008c', icon: '⚙️' },
  code: { label: 'Kod & Metin', color: '#498205', icon: '💻' },
  other: { label: 'Diğer', color: '#69797e', icon: '📃' },
};

const QUICK_ICONS = {
  desktop: '🖥️',
  downloads: '⬇️',
  documents: '📄',
  pictures: '🖼️',
  music: '🎵',
  videos: '🎬',
};


const MONTH_NAMES_TR = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const GENERIC_REL_WORDS = new Set(['vid', 'img', 'dsc', 'dcim', 'pxl', 'mvimg', 'wa', 'snap', 'screenshot', 'screen', 'recording', 'rec', 'video', 'photo', 'foto', 'resim', 'image', 'copy', 'kopya', 'mp4', 'jpg', 'jpeg', 'png', 'mov', 'mkv', 'webm']);

export {
  CAT_META,
  GENERIC_REL_WORDS,
  ICONS,
  MONTH_NAMES_TR,
  QUICK_ICONS,
};
