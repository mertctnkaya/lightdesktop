import { $ } from '../../utils/dom.js';
import { state } from '../../store/appState.js';
import { enqueueTransfer } from './fileActions.js';
import { toast } from '../shared/toast.js';
import { api } from '../../services/apiClient.js';
import { recordRecentTransferTarget, setTreeNodeExpanded } from '../sidebar/treeAndDashboard.js';
import { getActiveTab, getFolderTitle, navigateTo } from '../navigation/tabsAndRouter.js';
import { addItemsToBasket, navigateDual, renderBasket } from './basketAndDualPane.js';
import { resolveDragOp } from '../../core/transferRulesEngine.js';
import { isDragFileHandle, updateStatusCounts, updateToolbarButtons } from '../scroller/selectionAndMarquee.js';
import { updateSelectionDomInPlace } from '../scroller/virtualScroller.js';
import { addItemsToShelf, renderDragShelf, setShelfAutoReveal } from '../sidebar/dragShelf.js';

// ---------- Sürükle-Bırak (Drag & Drop) Motoru ----------
function setupDragAndDrop() {
  let hoverExpandTimer = null;
  let hoverExpandPath = '';
  let currentDropEl = null;

  const setDropHighlight = (el) => {
    if (currentDropEl && currentDropEl !== el) {
      currentDropEl.classList.remove('drop-target-hover');
    }
    currentDropEl = el;
    if (el) el.classList.add('drop-target-hover');
  };

  const clearHoverExpand = () => {
    clearTimeout(hoverExpandTimer);
    hoverExpandTimer = null;
    hoverExpandPath = '';
  };

  const normDir = (p) => {
    const clean = String(p || '').replace(/\\+$/, '');
    return (/^[a-zA-Z]:$/.test(clean) ? clean + '\\' : clean).toLowerCase();
  };

  const getParentDir = (p) => {
    const clean = String(p || '').replace(/\\+$/, '');
    const idx = clean.lastIndexOf('\\');
    if (idx < 0) return '';
    const parent = clean.slice(0, idx);
    return /^[a-zA-Z]:$/.test(parent) ? parent + '\\' : parent;
  };

  const canDropInto = (targetDir, isCopy) => {
    if (!state.draggedPaths.length || !targetDir || targetDir === 'PC' || targetDir === 'TRASH') return false;
    const nt = normDir(targetDir);
    for (const src of state.draggedPaths) {
      const ns = normDir(src);
      if (ns === nt || nt.startsWith(ns.replace(/\\$/, '') + '\\')) return false;
    }
    if (!isCopy) {
      const hasMovable = state.draggedPaths.some((src) => normDir(getParentDir(src)) !== nt);
      if (!hasMovable) return false;
    }
    return true;
  };

  const executeDropPaths = async (paths, targetDir, isCopy) => {
    setDropHighlight(null);
    clearHoverExpand();
    if (!paths || paths.length === 0 || !targetDir) return;
    const nt = normDir(targetDir);
    const filtered = isCopy ? paths.slice() : paths.filter((src) => normDir(getParentDir(src)) !== nt);
    if (filtered.length === 0) return;

    document.querySelectorAll('.sidebar .tree-node[data-loaded="1"]').forEach((node) => {
      const rowPath = node.querySelector(':scope > .tree-row')?.dataset.path;
      if (rowPath && normDir(rowPath) === nt) {
        node.dataset.loaded = '0';
      }
    });
    await enqueueTransfer(isCopy ? 'copy' : 'move', filtered, targetDir);
  };

  const isExternalFilesDrag = (e) => {
    if (state.draggedPaths.length > 0 || !e || !e.dataTransfer) return false;
    const types = e.dataTransfer.types;
    if (!types) return false;
    return Array.from(types).includes('Files');
  };

  const canDropExternalInto = (targetDir) => Boolean(targetDir && targetDir !== 'PC' && targetDir !== 'TRASH');

  const handleExternalDrop = async (e, targetDir, targetKind = 'dir') => {
    e.preventDefault();
    setDropHighlight(null);
    clearHoverExpand();
    if (targetKind === 'dir' && !canDropExternalInto(targetDir)) return;
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length === 0) return;

    if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessageWithAdditionalObjects === 'function') {
      window.chrome.webview.postMessageWithAdditionalObjects(
        {
          type: 'resolveExternalDrop',
          targetDir: targetDir || '',
          targetKind,
          ctrlKey: Boolean(e.ctrlKey),
          shiftKey: Boolean(e.shiftKey),
        },
        files
      );
      return;
    }

    if (targetKind !== 'dir') {
      toast('Tarayıcı modunda dışarıdan doğrudan sepete bırakma desteklenmiyor.', 'info');
      return;
    }
    toast(`Dışarıdan ${files.length} dosya aktarılıyor...`, 'info');
    let okCount = 0;
    for (const f of files) {
      if (!f || f.size === 0 && !f.type) {
        // Tarayıcı modunda boş klasör yüklemesi kısıtlıdır; normal dosyaları aktar
      }
      try {
        const upRes = await fetch(`/api/fs/upload-external?destDir=${encodeURIComponent(targetDir)}&name=${encodeURIComponent(f.name)}`, {
          method: 'POST',
          body: f,
        });
        if (upRes.ok) okCount++;
      } catch {}
    }
    if (okCount > 0) {
      recordRecentTransferTarget(targetDir);
      toast(`${okCount} dosya hedef klasöre kopyalandı`, 'success');
      const tab = getActiveTab();
      if (tab && tab.path && normDir(tab.path) === normDir(targetDir)) {
        navigateTo(tab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
      }
      if (state.dualOpen && state.dualPath && normDir(state.dualPath) === normDir(targetDir)) {
        navigateDual(state.dualPath, false);
      }
    } else {
      toast('Dışarıdan klasör aktarımı için LightDesktop.exe kullanın veya Ctrl+V ile yapıştırın.', 'info');
    }
  };

  const handleDropToDir = async (e, targetDir) => {
    if (isExternalFilesDrag(e)) {
      await handleExternalDrop(e, targetDir, 'dir');
      return;
    }
    e.preventDefault();
    setDropHighlight(null);
    clearHoverExpand();
    const op = resolveDragOp(state.draggedPaths, targetDir, e.ctrlKey, e.shiftKey);
    const isCopy = op === 'copy';
    if (!canDropInto(targetDir, isCopy)) return;
    await executeDropPaths(state.draggedPaths, targetDir, isCopy);
  };

  const isNativeWebView = Boolean(window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function');
  const vp = $('virtual-viewport');
  const dualList = $('dual-list');

  if (isNativeWebView) {
    // WebView2 yerel modunda sürüklemeyi kesintisiz kontrol edip pencere dışına çıkınca gerçek Windows CF_HDROP sürüklemesi başlat
    const suppressNativeDrag = (e) => e.preventDefault();
    vp.addEventListener('dragstart', suppressNativeDrag);
    if (dualList) dualList.addEventListener('dragstart', suppressNativeDrag);

    let ghostEl = null;
    let pState = null;

    const removeGhost = () => {
      if (ghostEl) {
        ghostEl.remove();
        ghostEl = null;
      }
    };

    const cleanupPointerDrag = () => {
      if (pState && pState.captureEl && pState.pointerId !== null) {
        try { pState.captureEl.releasePointerCapture(pState.pointerId); } catch {}
      }
      pState = null;
      removeGhost();
      setDropHighlight(null);
      clearHoverExpand();
    };

    const findInAppDropTarget = (clientX, clientY, ctrlKey, shiftKey) => {
      const el = document.elementFromPoint(clientX, clientY);
      if (!el) return null;
      const treeRow = el.closest('.sidebar .tree-row[data-path]');
      if (treeRow) {
        const op = resolveDragOp(state.draggedPaths, treeRow.dataset.path, ctrlKey, shiftKey);
        if (canDropInto(treeRow.dataset.path, op === 'copy')) {
          return { kind: 'dir', dir: treeRow.dataset.path, op, highlightEl: treeRow, treeNode: treeRow.closest('.tree-node') };
        }
      }
      const listRow = el.closest('#virtual-viewport [data-index]');
      if (listRow) {
        const it = state.viewItems[Number(listRow.dataset.index)];
        if (it && it.isDir) {
          const op = resolveDragOp(state.draggedPaths, it.path, ctrlKey, shiftKey);
          if (canDropInto(it.path, op === 'copy')) {
            return { kind: 'dir', dir: it.path, op, highlightEl: listRow };
          }
        }
      }
      const crumb = el.closest('#breadcrumbs .crumb-btn[data-path]');
      if (crumb) {
        const op = resolveDragOp(state.draggedPaths, crumb.dataset.path, ctrlKey, shiftKey);
        if (canDropInto(crumb.dataset.path, op === 'copy')) {
          return { kind: 'dir', dir: crumb.dataset.path, op, highlightEl: crumb };
        }
      }
      const shelfEl = el.closest('#drag-shelf');
      if (shelfEl) {
        return { kind: 'shelf', op: 'copy', highlightEl: shelfEl };
      }
      const basketEl = el.closest('#btn-basket, #basket-drawer');
      if (basketEl) {
        return { kind: 'basket', op: 'copy', highlightEl: basketEl };
      }
      const dList = el.closest('#dual-list');
      if (dList && state.dualPath) {
        const dRow = el.closest('.dual-row[data-isdir="1"]');
        const tDir = dRow ? dRow.dataset.path : state.dualPath;
        const op = resolveDragOp(state.draggedPaths, tDir, ctrlKey, shiftKey);
        if (canDropInto(tDir, op === 'copy')) {
          return { kind: 'dir', dir: tDir, op, highlightEl: dRow || dList };
        }
      }
      if (vp.contains(el) && (state.dragSource === 'dual' || state.dragSource === 'shelf')) {
        const tab = getActiveTab();
        if (tab && tab.path !== 'PC' && tab.path !== 'TRASH') {
          const op = resolveDragOp(state.draggedPaths, tab.path, ctrlKey, shiftKey);
          if (canDropInto(tab.path, op === 'copy')) {
            return { kind: 'dir', dir: tab.path, op, highlightEl: null };
          }
        }
      }
      return null;
    };

    const beginPointerDrag = (e, itemPaths, sourceKind) => {
      if (e.button !== 0 || e.altKey) return;
      pState = {
        startX: e.clientX,
        startY: e.clientY,
        pointerId: e.pointerId,
        captureEl: e.currentTarget,
        paths: itemPaths,
        sourceKind,
        active: false,
        handedOff: false,
      };
    };

    vp.addEventListener('pointerdown', (e) => {
      state.activePane = 'left';
      if (e.button !== 0 || e.altKey) return;
      if (e.target.closest('button, input, a, .eye-btn, .lh-resizer')) return;
      const rowEl = e.target.closest('[data-index]');
      if (!rowEl || !isDragFileHandle(e.target, rowEl)) return;
      const item = state.viewItems[Number(rowEl.dataset.index)];
      if (!item || item.inTrash) return;
      const paths = state.selectedPaths.has(item.path) ? Array.from(state.selectedPaths) : [item.path];
      beginPointerDrag(e, paths, 'vp');
    });

    if (dualList) {
      dualList.addEventListener('pointerdown', (e) => {
        state.activePane = 'dual';
        if (e.button !== 0 || e.altKey) return;
        const row = e.target.closest('.dual-row[data-path]');
        if (!row || !isDragFileHandle(e.target, row)) return;
        const p = row.dataset.path;
        const paths = state.dualSelectedPaths.has(p) ? Array.from(state.dualSelectedPaths) : [p];
        beginPointerDrag(e, paths, 'dual');
      });
    }

    window.addEventListener('pointermove', (e) => {
      if (!pState || pState.handedOff) return;
      if ((e.buttons & 1) !== 1) {
        if (pState.active) {
          state.draggedPaths = [];
          cleanupPointerDrag();
        } else {
          pState = null;
        }
        return;
      }

      if (!pState.active) {
        if (Math.hypot(e.clientX - pState.startX, e.clientY - pState.startY) < 6) return;
        pState.active = true;
        state.dragSource = pState.sourceKind;
        state.draggedPaths = pState.paths.slice();
        if (pState.sourceKind === 'vp' && state.draggedPaths.length === 1 && !state.selectedPaths.has(state.draggedPaths[0])) {
          state.selectedPaths.clear();
          state.selectedPaths.add(state.draggedPaths[0]);
          updateSelectionDomInPlace();
          updateStatusCounts();
          updateToolbarButtons();
        }
        try { pState.captureEl.setPointerCapture(pState.pointerId); } catch {}
        setShelfAutoReveal(true);
        ghostEl = document.createElement('div');
        ghostEl.className = 'drag-ghost-pill';
        document.body.appendChild(ghostEl);
      }

      const outsideWindow = e.clientX <= 1 || e.clientY <= 1 || e.clientX >= window.innerWidth - 1 || e.clientY >= window.innerHeight - 1;
      if (outsideWindow) {
        pState.handedOff = true;
        const dragPaths = state.draggedPaths.slice();
        cleanupPointerDrag();
        setShelfAutoReveal(false);
        state.suppressNextClick = true;
        setTimeout(() => { state.suppressNextClick = false; }, 120);
        window.chrome.webview.postMessage({ type: 'startNativeFileDrag', paths: dragPaths });
        return;
      }

      const hit = findInAppDropTarget(e.clientX, e.clientY, e.ctrlKey, e.shiftKey);
      if (ghostEl) {
        const isCopyOp = hit ? (hit.op === 'copy') : e.ctrlKey;
        const prefix = hit && hit.kind === 'shelf' ? '🧲 Rafa Park Et: ' : (isCopyOp ? '📋 Kopyala: ' : '📦 Taşı: ');
        const label = state.draggedPaths.length === 1
          ? getFolderTitle(state.draggedPaths[0])
          : `${state.draggedPaths.length} öğe`;
        ghostEl.textContent = prefix + label;
        ghostEl.style.left = `${e.clientX + 14}px`;
        ghostEl.style.top = `${e.clientY + 14}px`;
      }

      setDropHighlight(hit ? hit.highlightEl : null);
      if (hit && hit.treeNode) {
        const twisty = hit.treeNode.querySelector('.tree-twisty');
        const tPath = hit.dir;
        if (twisty && !twisty.classList.contains('expanded') && !twisty.classList.contains('empty')) {
          if (hoverExpandPath !== tPath) {
            clearHoverExpand();
            hoverExpandPath = tPath;
            hoverExpandTimer = setTimeout(() => {
              setTreeNodeExpanded(hit.treeNode, tPath, Number(hit.treeNode.dataset.depth || 0), true);
            }, 550);
          }
        } else if (hoverExpandPath !== tPath) {
          clearHoverExpand();
        }
      } else {
        clearHoverExpand();
      }
    });

    const shelfHandle = $('drag-shelf-drag-handle');
    if (shelfHandle) {
      shelfHandle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || state.shelfItems.size === 0) return;
        beginPointerDrag(e, Array.from(state.shelfItems.keys()), 'shelf');
      });
    }

    window.addEventListener('pointerup', (e) => {
      if (!pState) return;
      if (!pState.active) {
        pState = null;
        return;
      }
      if (pState.handedOff) {
        pState = null;
        return;
      }
      const dragPaths = state.draggedPaths.slice();
      const dragSource = state.dragSource;
      const dragPool = dragSource === 'dual'
        ? state.dualItems
        : (dragSource === 'shelf' ? Array.from(state.shelfItems.values()) : state.viewItems);
      const hit = findInAppDropTarget(e.clientX, e.clientY, e.ctrlKey, e.shiftKey);
      cleanupPointerDrag();
      state.draggedPaths = [];
      state.dragSource = null;
      state.suppressNextClick = true;
      setTimeout(() => { state.suppressNextClick = false; }, 120);

      if (hit && hit.kind === 'shelf') {
        const draggedSet = new Set(dragPaths);
        const matched = dragPool.filter((it) => draggedSet.has(it.path));
        addItemsToShelf(matched.length > 0 ? matched : dragPaths);
      } else if (hit && hit.kind === 'basket') {
        const draggedSet = new Set(dragPaths);
        const matched = dragPool.filter((it) => draggedSet.has(it.path));
        if (matched.length > 0) addItemsToBasket(matched);
      } else if (hit && hit.kind === 'dir') {
        executeDropPaths(dragPaths, hit.dir, hit.op === 'copy');
        if (dragSource === 'shelf' && hit.op !== 'copy') {
          for (const dp of dragPaths) state.shelfItems.delete(dp);
          renderDragShelf();
        }
      }
      setShelfAutoReveal(false);
    });

    window.chrome.webview.addEventListener('message', (ev) => {
      const msg = ev && ev.data;
      if (!msg) return;
      if (msg.type === 'externalDropResolved') {
        const paths = Array.isArray(msg.paths) ? msg.paths.filter(Boolean) : [];
        if (paths.length === 0) return;
        if (msg.targetKind === 'basket') {
          let added = 0;
          for (const p of paths) {
            if (!state.basket.has(p)) {
              state.basket.set(p, { path: p, name: getFolderTitle(p), isDir: false });
              added++;
            }
          }
          renderBasket();
          toast(added > 0 ? `${added} öğe sepete eklendi` : 'Öğeler zaten sepette');
        } else if (canDropExternalInto(msg.targetDir)) {
          const op = resolveDragOp(paths, msg.targetDir, Boolean(msg.ctrlKey), Boolean(msg.shiftKey));
          executeDropPaths(paths, msg.targetDir, op === 'copy');
        }
        return;
      }
      if (msg.type !== 'nativeDragDone') return;
      state.draggedPaths = [];
      state.dragSource = null;
      if (msg.effect === 'Move' && Array.isArray(msg.paths)) {
        let dirtyBasket = false;
        for (const p of msg.paths) {
          if (state.basket.delete(p)) dirtyBasket = true;
        }
        if (dirtyBasket) renderBasket();
        const tab = getActiveTab();
        if (tab && tab.path && tab.path !== 'PC' && tab.path !== 'TRASH') {
          navigateTo(tab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
        }
      }
    });
  } else {
    vp.addEventListener('dragstart', (e) => {
      const rowEl = e.target.closest('[data-index]');
      if (!rowEl) return;
      const item = state.viewItems[Number(rowEl.dataset.index)];
      if (!item) return;

      if (!state.selectedPaths.has(item.path)) {
        state.selectedPaths.clear();
        state.selectedPaths.add(item.path);
        state.lastClickedIndex = Number(rowEl.dataset.index);
        updateSelectionDomInPlace();
        updateStatusCounts();
        updateToolbarButtons();
      }

      state.draggedPaths = Array.from(state.selectedPaths);
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('text/plain', state.draggedPaths.join('\n'));
        if (state.draggedPaths.length === 1 && !item.isDir) {
          const dlUrl = `${window.location.origin}/api/media?path=${encodeURIComponent(item.path)}`;
          try { e.dataTransfer.setData('DownloadURL', `application/octet-stream:${item.name}:${dlUrl}`); } catch {}
        }
      }
    });
  }

  document.addEventListener('dragover', (e) => {
    if (isExternalFilesDrag(e)) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    if (isExternalFilesDrag(e) && !e.defaultPrevented) e.preventDefault();
  });

  document.addEventListener('dragend', () => {
    state.draggedPaths = [];
    setDropHighlight(null);
    clearHoverExpand();
  });

  // 1) Sol Menü Ağacı (Diskler, Hızlı Erişim, Sabitlenenler ve tüm alt klasörler)
  const sidebar = document.querySelector('.sidebar');
  sidebar.addEventListener('dragover', (e) => {
    const row = e.target.closest('.tree-row[data-path]');
    const extDrag = isExternalFilesDrag(e);
    const op = row ? (extDrag ? (e.shiftKey ? 'move' : 'copy') : resolveDragOp(state.draggedPaths, row.dataset.path, e.ctrlKey, e.shiftKey)) : 'move';
    const valid = row && (extDrag ? canDropExternalInto(row.dataset.path) : canDropInto(row.dataset.path, op === 'copy'));
    if (!valid) {
      if (currentDropEl && sidebar.contains(currentDropEl)) setDropHighlight(null);
      clearHoverExpand();
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = op;
    setDropHighlight(row);

    const node = row.closest('.tree-node');
    const twisty = row.querySelector('.tree-twisty');
    const path = row.dataset.path;
    if (node && twisty && !twisty.classList.contains('expanded') && !twisty.classList.contains('empty')) {
      if (hoverExpandPath !== path) {
        clearHoverExpand();
        hoverExpandPath = path;
        hoverExpandTimer = setTimeout(() => {
          setTreeNodeExpanded(node, path, Number(node.dataset.depth || 0), true);
        }, 550);
      }
    } else if (hoverExpandPath !== path) {
      clearHoverExpand();
    }
  });
  sidebar.addEventListener('dragleave', (e) => {
    if (!sidebar.contains(e.relatedTarget)) {
      setDropHighlight(null);
      clearHoverExpand();
    }
  });
  sidebar.addEventListener('drop', (e) => {
    const row = e.target.closest('.tree-row[data-path]');
    if (row) handleDropToDir(e, row.dataset.path);
  });

  // 2) Orta Listedeki Klasörler
  vp.addEventListener('dragover', (e) => {
    const rowEl = e.target.closest('[data-index]');
    const item = rowEl ? state.viewItems[Number(rowEl.dataset.index)] : null;
    const extDrag = isExternalFilesDrag(e);
    const op = item && item.isDir ? (extDrag ? (e.shiftKey ? 'move' : 'copy') : resolveDragOp(state.draggedPaths, item.path, e.ctrlKey, e.shiftKey)) : 'move';
    const valid = item && item.isDir && (extDrag ? canDropExternalInto(item.path) : canDropInto(item.path, op === 'copy'));
    if (!valid) {
      if (currentDropEl && vp.contains(currentDropEl)) setDropHighlight(null);
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = op;
    setDropHighlight(rowEl);
  });
  vp.addEventListener('dragleave', (e) => {
    if (!vp.contains(e.relatedTarget)) setDropHighlight(null);
  });
  vp.addEventListener('drop', (e) => {
    const rowEl = e.target.closest('[data-index]');
    const item = rowEl ? state.viewItems[Number(rowEl.dataset.index)] : null;
    if (item && item.isDir) handleDropToDir(e, item.path);
  });

  // 3) Üst Yol Çubuğu (Breadcrumbs)
  const bc = $('breadcrumbs');
  bc.addEventListener('dragover', (e) => {
    const btn = e.target.closest('.crumb-btn[data-path]');
    const extDrag = isExternalFilesDrag(e);
    const op = btn ? (extDrag ? (e.shiftKey ? 'move' : 'copy') : resolveDragOp(state.draggedPaths, btn.dataset.path, e.ctrlKey, e.shiftKey)) : 'move';
    const valid = btn && (extDrag ? canDropExternalInto(btn.dataset.path) : canDropInto(btn.dataset.path, op === 'copy'));
    if (!valid) {
      if (currentDropEl && bc.contains(currentDropEl)) setDropHighlight(null);
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = op;
    setDropHighlight(btn);
  });
  bc.addEventListener('dragleave', (e) => {
    if (!bc.contains(e.relatedTarget)) setDropHighlight(null);
  });
  bc.addEventListener('drop', (e) => {
    const btn = e.target.closest('.crumb-btn[data-path]');
    if (btn) handleDropToDir(e, btn.dataset.path);
  });

  // 4) Sepet Butonu & Sepet Çekmecesi
  for (const targetEl of [$('btn-basket'), $('basket-drawer')]) {
    targetEl.addEventListener('dragover', (e) => {
      if (!state.draggedPaths.length && !isExternalFilesDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setDropHighlight(targetEl);
    });
    targetEl.addEventListener('dragleave', (e) => {
      if (!targetEl.contains(e.relatedTarget)) setDropHighlight(null);
    });
    targetEl.addEventListener('drop', (e) => {
      if (isExternalFilesDrag(e)) {
        handleExternalDrop(e, '', 'basket');
        return;
      }
      e.preventDefault();
      setDropHighlight(null);
      if (!state.draggedPaths.length) return;
      const draggedSet = new Set(state.draggedPaths);
      const matched = state.viewItems.filter((it) => draggedSet.has(it.path));
      if (matched.length > 0) addItemsToBasket(matched);
    });
  }

  // 5) Çift Panel (Dual Pane) Sürükle-Bırak
  if (dualList && !isNativeWebView) {
    dualList.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.dual-row');
      if (!row) return;
      const p = row.dataset.path;
      state.draggedPaths = state.dualSelectedPaths.has(p) ? Array.from(state.dualSelectedPaths) : [p];
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('text/plain', state.draggedPaths[0] || p);
      }
    });
  }
  dualList.addEventListener('dragover', (e) => {
    const extDrag = isExternalFilesDrag(e);
    if ((!state.draggedPaths.length && !extDrag) || !state.dualPath) return;
    const row = e.target.closest('.dual-row[data-isdir="1"]');
    const targetDir = row ? row.dataset.path : state.dualPath;
    const op = extDrag ? (e.shiftKey ? 'move' : 'copy') : resolveDragOp(state.draggedPaths, targetDir, e.ctrlKey, e.shiftKey);
    const valid = extDrag ? canDropExternalInto(targetDir) : canDropInto(targetDir, op === 'copy');
    if (!valid) {
      if (currentDropEl && dualList.contains(currentDropEl)) setDropHighlight(null);
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = op;
    setDropHighlight(row || dualList);
  });
  dualList.addEventListener('dragleave', (e) => {
    if (!dualList.contains(e.relatedTarget)) setDropHighlight(null);
  });
  dualList.addEventListener('drop', (e) => {
    const row = e.target.closest('.dual-row[data-isdir="1"]');
    const targetDir = row ? row.dataset.path : state.dualPath;
    if (targetDir) handleDropToDir(e, targetDir);
  });

  // Soldaki boş alana (sağ panelden veya dış uygulamadan / masaüstünden) sürükleyip bırakma
  vp.addEventListener('dragover', (e) => {
    const rowEl = e.target.closest('[data-index]');
    const item = rowEl ? state.viewItems[Number(rowEl.dataset.index)] : null;
    if (item && item.isDir) return;
    const tab = getActiveTab();
    if (!tab || tab.path === 'PC' || tab.path === 'TRASH') return;
    const extDrag = isExternalFilesDrag(e);
    const op = extDrag ? (e.shiftKey ? 'move' : 'copy') : resolveDragOp(state.draggedPaths, tab.path, e.ctrlKey, e.shiftKey);
    const valid = extDrag ? canDropExternalInto(tab.path) : canDropInto(tab.path, op === 'copy');
    if (!valid) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = op;
  });
  vp.addEventListener('drop', (e) => {
    const rowEl = e.target.closest('[data-index]');
    const item = rowEl ? state.viewItems[Number(rowEl.dataset.index)] : null;
    if (item && item.isDir) return;
    const tab = getActiveTab();
    if (tab && tab.path !== 'PC' && tab.path !== 'TRASH') handleDropToDir(e, tab.path);
  });
}


export {
  setupDragAndDrop,
};
