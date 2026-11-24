const state = {
  drives: [],
  quickAccess: [],
  pins: [],
  tabs: [],
  activeTabId: null,

  // Aktif klasör verileri
  rawItems: [],
  viewItems: [],
  selectedPaths: new Set(),
  lastClickedIndex: -1,

  // Görünüm & Sıralama
  sortBy: 'name',
  sortDir: 'asc',
  viewMode: 'list', // list | compact | grid
  globalViewMode: 'list',
  folderViews: {}, // normalizedPath -> viewMode
  colWidths: { name: null, mtime: null, ext: null, size: null },
  colFilters: { name: new Set(), mtime: new Set(), ext: new Set(), size: new Set() },
  suppressHeaderSortUntil: 0,
  activeFilterCol: null,
  thumbMode: 'off', // off | selected | viewport | all
  filterOnlyMatched: false,
  relatedCtx: null,

  // Pano & Sepet
  clipboard: { op: null, paths: [] },
  basket: new Map(), // path -> item

  // Arama
  searchTimer: null,
  searchQuery: '',

  // Kapak Resmi Sıralı İstemci Önbelleği (Concurrency = 1)
  thumbBlobCache: new Map(), // key -> objectURL
  thumbAbortCtrl: null,
  thumbQueueRunning: false,
  thumbSessionId: 1,
  viewportScrollTimer: null,
  folderSizeRunning: false,
  folderSizePath: '',
  folderSizesCache: new Map(), // folderPath -> bytes

  // QuickLook & Seçim zamanlayıcı
  qlIndex: -1,
  qlMediaItems: [],
  qlZoom: 1,
  qlPanX: 0,
  qlPanY: 0,
  qlBrightness: 100,
  lastClickPath: '',
  lastClickTime: 0,
  lastActivatedPath: '',
  lastActivatedTime: 0,
  suppressNextClick: false,
  expandedTreePaths: new Set(),
  draggedPaths: [],

  // Çift Panel (Dual Pane)
  dualOpen: false,
  dualPath: '',
  dualItems: [],
  dualSelectedPaths: new Set(),
  dualLastClickedIdx: -1,
  dualHistory: [],
  dualHistoryIdx: -1,
  activePane: 'left',

  // Çöp Kutusu & Geri Al (Ctrl+Z)
  trashCount: 0,
  undoSummary: { count: 0, canUndo: false, topLabel: '', topType: '' },

  // Hızlı Erişim: Son Açılan Klasörler & Son Erişilen Dosyalar
  recentFolders: [],
  recentFiles: [],
  recentTransferTargets: [], // En son dosya taşınan/kopyalanan max 15 hedef klasör (LRU)
  recentTargetsOpen: true,
  dashSections: { quick: true, folders: true, files: true },

  // Akıllı Klasörler (Sanal Görünüm) & Geçici Yüzen Raf
  smartViews: [],
  smartViewsOpen: true,
  smartViewCtx: null,
  shelfItems: new Map(),
  shelfPinned: false,

  // Uygulama Ayarları
  settings: {
    accentColor: '#0078d4',
    fontSize: 13,
    foldersFirst: true,
    showExtensions: true,
    compactSidebar: false,
    defaultViewMode: 'last', // last | list | dense | compact | tiles | grid-sm | grid | grid-lg | grid-xl
    rememberFolderView: true,
    startupMode: 'pc', // pc | last | custom
    startupPath: '',
    clickMode: 'double', // double | single
    trashConfirmMode: 'bulk', // bulk | always | never
    autoCloseProcessModal: false,
    defaultThumbMode: 'off',
    dblClickQuickLook: true,
    frameSaveMode: 'same', // same | custom
    frameSaveDir: '',
    trimSaveMode: 'same', // same | custom
    trimSaveDir: '',
    videoAutoplay: true,
    videoLoop: false,
  },
};

const DEFAULT_APP_SETTINGS = { ...state.settings };

const naturalCollator = new Intl.Collator('tr', { numeric: true, sensitivity: 'base' });


export {
  DEFAULT_APP_SETTINGS,
  naturalCollator,
  state,
};
