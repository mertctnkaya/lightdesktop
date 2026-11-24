'use strict';

// LightDesktop İndeksleyici & Medya Motoru — 5S Modüler Giriş Cephesi (Facade)

const sqliteConn = require('./indexer/db/sqliteConnection');
const classifier = require('./indexer/core/categoryClassifier');
const relatedMatcher = require('./indexer/core/relatedMatcherEngine');
const searchEngine = require('./indexer/services/searchEngine');
const backgroundIndexer = require('./indexer/services/backgroundIndexer');
const scanProgress = require('./indexer/services/scanProgressTracker');
const diskAnalyzer = require('./indexer/services/diskAnalyzer');
const folderSizeEngine = require('./indexer/services/folderSizeEngine');
const duplicateFinder = require('./indexer/services/duplicateFinder');
const analysisCache = require('./indexer/services/analysisCacheAndSmartViews');
const thumbnailEngine = require('./indexer/services/thumbnailEngine');
const storyboardEngine = require('./indexer/services/storyboardEngine');

module.exports = {
  CACHE_ROOT: sqliteConn.CACHE_ROOT,
  THUMBS_DIR: sqliteConn.THUMBS_DIR,
  STORYBOARDS_DIR: sqliteConn.STORYBOARDS_DIR,
  getCategory: classifier.getCategory,
  upsertDirEntries: sqliteConn.upsertDirEntries,
  getCachedStatsMap: sqliteConn.getCachedStatsMap,
  removeIndexedPath: sqliteConn.removeIndexedPath,
  searchFiles: searchEngine.searchFiles,
  findRelatedFiles: relatedMatcher.findRelatedFiles,
  startBackgroundIndex: backgroundIndexer.startBackgroundIndex,
  stopBackgroundIndex: backgroundIndexer.stopBackgroundIndex,
  controlBackgroundIndex: backgroundIndexer.controlBackgroundIndex,
  getIndexStats: backgroundIndexer.getIndexStats,
  analyzeFromCache: diskAnalyzer.analyzeFromCache,
  analyzeLive: diskAnalyzer.analyzeLive,
  getScanProgress: scanProgress.getScanProgress,
  controlScanProgress: scanProgress.controlScanProgress,
  calculateFolderSizes: folderSizeEngine.calculateFolderSizes,
  cancelFolderSizes: folderSizeEngine.cancelFolderSizes,
  findDuplicates: duplicateFinder.findDuplicates,
  makeThumbKey: classifier.makeThumbKey,
  getThumbCacheInfo: thumbnailEngine.getThumbCacheInfo,
  getOrCreateThumbnail: thumbnailEngine.getOrCreateThumbnail,
  cancelThumbQueue: thumbnailEngine.cancelThumbQueue,
  clearThumbCache: thumbnailEngine.clearThumbCache,
  getPins: sqliteConn.getPins,
  addPin: sqliteConn.addPin,
  removePin: sqliteConn.removePin,
  getFfmpegBin: thumbnailEngine.getFfmpegBin,
  runWindowsShellThumb: thumbnailEngine.runWindowsShellThumb,
  getAnalysisCache: analysisCache.getAnalysisCache,
  setAnalysisCache: analysisCache.setAnalysisCache,
  querySmartView: analysisCache.querySmartView,
  getOrCreateVideoStoryboard: storyboardEngine.getOrCreateVideoStoryboard,
  getDbInitWarning: sqliteConn.getDbInitWarning,
};
