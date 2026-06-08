'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

// ── Constants ────────────────────────────────────────────────────────────────
const BASE = '/data/BDMAP_00000338';

// Custom colormap RGB endpoints (black → organ color).
// NiiVue only recognises a small set of built-in names; unknown names silently
// fall back to gray.  We register a two-stop custom colormap for every organ
// so the exact hex color is always used, regardless of NiiVue version.
const ORGAN_CMAP_RGB: Record<string, [number, number, number]> = {
  liver:        [239,  68,  68],  // #ef4444
  spleen:       [ 59, 130, 246],  // #3b82f6
  pancreas:     [234, 179,   8],  // #eab308
  kidney_left:  [ 34, 197,  94],  // #22c55e
  kidney_right: [  6, 182, 212],  // #06b6d4
  aorta:        [249, 115,  22],  // #f97316
  stomach:      [236,  72, 153],  // #ec4899
  postcava:     [168,  85, 247],  // #a855f7
  gall_bladder: [132, 204,  22],  // #84cc16
};

const ORGANS = [
  { id: 'liver',        name: 'Liver',        colormap: 'liver',        hex: '#ef4444' },
  { id: 'spleen',       name: 'Spleen',       colormap: 'spleen',       hex: '#3b82f6' },
  { id: 'pancreas',     name: 'Pancreas',     colormap: 'pancreas',     hex: '#eab308' },
  { id: 'kidney_left',  name: 'Left Kidney',  colormap: 'kidney_left',  hex: '#22c55e' },
  { id: 'kidney_right', name: 'Right Kidney', colormap: 'kidney_right', hex: '#06b6d4' },
  { id: 'aorta',        name: 'Aorta',        colormap: 'aorta',        hex: '#f97316' },
  { id: 'stomach',      name: 'Stomach',      colormap: 'stomach',      hex: '#ec4899' },
  { id: 'postcava',     name: 'Postcava',     colormap: 'postcava',     hex: '#a855f7' },
  { id: 'gall_bladder', name: 'Gallbladder',  colormap: 'gall_bladder', hex: '#84cc16' },
] as const;

type OrganId = typeof ORGANS[number]['id'];

const WL_PRESETS = [
  { name: 'Soft Tissue', ww: 400,  wl: 40   },
  { name: 'Bone',        ww: 1500, wl: 300  },
  { name: 'Lung',        ww: 1500, wl: -600 },
  { name: 'Liver',       ww: 150,  wl: 70   },
] as const;

type PresetName = typeof WL_PRESETS[number]['name'];

type ViewMode = 'mpr' | 'axial' | 'sagittal' | 'coronal' | '3d';

const VIEW_MODES: { id: ViewMode; label: string }[] = [
  { id: 'mpr',      label: '⊞ MPR'    },
  { id: 'axial',    label: 'Axial'    },
  { id: 'sagittal', label: 'Sag'      },
  { id: 'coronal',  label: 'Cor'      },
  { id: '3d',       label: '3D'       },
];

// Overlay colors for user-dropped masks (cycles through these)
const DROP_COLORS = ['red','green','blue','yellow','warm','cool','pink','winter','summer'];

// ── Component ────────────────────────────────────────────────────────────────
export default function CTViewer() {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nvRef      = useRef<any>(null);
  const dropColorIdx = useRef(0);
  const ctInputRef = useRef<HTMLInputElement>(null);
  const maskInputRef = useRef<HTMLInputElement>(null);

  const [loading,      setLoading]      = useState(true);
  const [loadingMsg,   setLoadingMsg]   = useState('Initialising…');
  const [activePreset, setActivePreset] = useState<PresetName>('Soft Tissue');
  // PresetName type is inferred from WL_PRESETS — 'Brain' is now 'Liver'
  const [viewMode,     setViewMode]     = useState<ViewMode>('mpr');
  const [opacities, setOpacities] = useState<Record<OrganId, number>>(
    Object.fromEntries(ORGANS.map(o => [o.id, 0.6])) as Record<OrganId, number>
  );
  const [isDragOver,   setIsDragOver]   = useState(false);
  const [visible, setVisible] = useState<Record<OrganId, boolean>>(
    Object.fromEntries(ORGANS.map(o => [o.id, true])) as Record<OrganId, boolean>
  );
  const [probe, setProbe] = useState<{
    hu: number | null; mm: number[]; vox: number[]
  }>({ hu: null, mm: [], vox: [] });
  const [spacing, setSpacing] = useState<[number, number, number] | null>(null);
  const [showAbout,    setShowAbout]    = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [organStats,   setOrganStats]   = useState<Partial<Record<OrganId, { volumeMl: number; meanHU: number }>>>({});
  const [isMeasuring,  setIsMeasuring]  = useState(false);

  // ── Init NiiVue ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current) return;
    let cancelled = false;

    (async () => {
      const { Niivue, NVImage } = await import('@niivue/niivue');
      if (cancelled) return;

      const nv = new Niivue({
        show3Dcrosshair: true,
        backColor:       [0.06, 0.06, 0.08, 1],
        crosshairColor:  [1, 0.25, 0.25, 0.9],
        crosshairWidth:  1,
        isResizeCanvas:  true,
      });
      nvRef.current = nv;

      // Data Probe — fires on every crosshair move (mirrors Slicer's Data Probe panel)
      nv.onLocationChange = (data: any) => {
        setProbe({
          hu:  (data.values?.[0] != null && isFinite(data.values[0])) ? Math.round(data.values[0]) : null,
          mm:  data.mm  ?? [],
          vox: data.vox ?? [],
        });
      };

      await nv.attachToCanvas(canvasRef.current!);

      // Register custom per-organ colormaps (black → organ color).
      // Must happen after attachToCanvas but before loadVolumes.
      ORGANS.forEach(organ => {
        const [r, g, b] = ORGAN_CMAP_RGB[organ.id];
        nv.addColormap(organ.id, { R: [0, r], G: [0, g], B: [0, b], A: [0, 255], I: [0, 255] });
      });

      // Load CT (browser may already have it cached from the <link rel="preload"> hint)
      setLoadingMsg('Loading CT scan…');
      await nv.loadVolumes([{
        url:      `${BASE}/ct.nii.gz`,
        colormap: 'gray',
        cal_min:  -160,
        cal_max:  240,
      }]);

      // ── Parallel mask loading (all 9 at once — much faster than sequential) ──
      setLoadingMsg('Loading segmentations…');
      const maskVols = await Promise.all(
        ORGANS.map(organ =>
          NVImage.loadFromUrl({
            url:      `${BASE}/segmentations/${organ.id}.nii.gz`,
            colormap: organ.colormap,
            opacity:  0.6,
            cal_min:  0.5,
            cal_max:  1.5,
          })
        )
      );
      if (cancelled) return;
      maskVols.forEach(vol => nv.addVolume(vol));

      // Read voxel spacing from the CT volume header (pixDims indices 1-3 = x,y,z mm)
      const pd = nv.volumes[0]?.pixDims;
      if (pd && pd.length >= 4) {
        setSpacing([
          parseFloat(Math.abs(pd[1]).toFixed(2)),
          parseFloat(Math.abs(pd[2]).toFixed(2)),
          parseFloat(Math.abs(pd[3]).toFixed(2)),
        ]);
      }

      nv.opts.multiplanarShowRender = 1;
      nv.setSliceType(nv.sliceTypeMultiplanar);

      if (!cancelled) setLoading(false);

      // ── Organ volume & HU stats (single pass over voxel data) ──────────────
      setTimeout(() => {
        try {
          const ctVol = nv.volumes[0];
          if (!ctVol?.img) return;
          const ctData = ctVol.img as Float32Array;
          const pd = ctVol.pixDims;
          const voxelMl = pd ? Math.abs(pd[1]) * Math.abs(pd[2]) * Math.abs(pd[3]) / 1000 : 1;
          // Apply NIfTI scl_slope / scl_inter to convert raw voxel values → HU
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hdr = (ctVol as any).hdr;
          const slope = (hdr?.scl_slope && hdr.scl_slope !== 0) ? hdr.scl_slope : 1;
          const inter = hdr?.scl_inter ?? 0;

          const maskArrays = ORGANS.map((_, i) => nv.volumes[i + 1]?.img as Float32Array | undefined);
          if (!maskArrays[0]) return;
          const counts = new Array(ORGANS.length).fill(0);
          const huSums = new Array(ORGANS.length).fill(0);
          const n = maskArrays[0]!.length;

          for (let j = 0; j < n; j++) {
            const raw = ctData[j];
            for (let i = 0; i < ORGANS.length; i++) {
              if ((maskArrays[i]?.[j] ?? 0) > 0.5) { counts[i]++; huSums[i] += raw; }
            }
          }

          const stats: Partial<Record<OrganId, { volumeMl: number; meanHU: number }>> = {};
          ORGANS.forEach((organ, i) => {
            if (counts[i] > 0) {
              stats[organ.id] = {
                volumeMl: parseFloat((counts[i] * voxelMl).toFixed(1)),
                meanHU:   Math.round((huSums[i] / counts[i]) * slope + inter),
              };
            }
          });
          if (!cancelled) setOrganStats(stats);
        } catch (_) { /* silently ignore */ }
      }, 600);

    })().catch(err => {
      console.error(err);
      setLoadingMsg('Error loading data — check console.');
    });

    return () => { cancelled = true; };
  }, []);

  // ── View mode ──────────────────────────────────────────────────────────────
  const applyViewMode = useCallback((mode: ViewMode) => {
    const nv = nvRef.current;
    if (!nv) return;
    setViewMode(mode);

    // Batch all opacity writes then commit to GPU once via updateGLVolume,
    // then switch slice type (its internal drawScene picks up the new opacities).
    if (mode === '3d') {
      if (nv.volumes[0]) nv.volumes[0].opacity = 0.07;
      ORGANS.forEach((organ, i) => {
        if (nv.volumes[i + 1]) nv.volumes[i + 1].opacity = visible[organ.id] ? 0.9 : 0;
      });
    } else {
      if (nv.volumes[0]) nv.volumes[0].opacity = 1;
      ORGANS.forEach((organ, i) => {
        if (nv.volumes[i + 1]) nv.volumes[i + 1].opacity = visible[organ.id] ? opacities[organ.id] : 0;
      });
    }
    nv.updateGLVolume();

    const map: Record<ViewMode, number> = {
      axial:    nv.sliceTypeAxial,
      sagittal: nv.sliceTypeSagittal,
      coronal:  nv.sliceTypeCoronal,
      mpr:      nv.sliceTypeMultiplanar,
      '3d':     nv.sliceTypeRender,
    };
    nv.setSliceType(map[mode]);
  }, [visible, opacities]);

  // ── W/L preset ─────────────────────────────────────────────────────────────
  const applyPreset = useCallback((preset: typeof WL_PRESETS[number]) => {
    const nv = nvRef.current;
    if (!nv || !nv.volumes[0]) return;
    setActivePreset(preset.name);
    nv.volumes[0].cal_min = preset.wl - preset.ww / 2;
    nv.volumes[0].cal_max = preset.wl + preset.ww / 2;
    nv.updateGLVolume();
  }, []);

  // ── Organ toggle ───────────────────────────────────────────────────────────
  const toggleOrgan = useCallback((id: OrganId) => {
    const nv = nvRef.current;
    if (!nv) return;
    const nowVisible = !visible[id];
    setVisible(prev => ({ ...prev, [id]: nowVisible }));
    const idx = ORGANS.findIndex(o => o.id === id) + 1;
    if (nv.volumes[idx] !== undefined) nv.setOpacity(idx, nowVisible ? opacities[id] : 0);
  }, [visible, opacities]);

  // ── Show all / Hide all ────────────────────────────────────────────────────
  const toggleAll = useCallback((show: boolean) => {
    const nv = nvRef.current;
    if (!nv) return;
    setVisible(Object.fromEntries(ORGANS.map(o => [o.id, show])) as Record<OrganId, boolean>);
    ORGANS.forEach((organ, i) => {
      if (nv.volumes[i + 1] !== undefined) nv.volumes[i + 1].opacity = show ? opacities[organ.id] : 0;
    });
    nv.updateGLVolume();
  }, [opacities]);

  // ── Per-organ opacity ──────────────────────────────────────────────────────
  const commitOrganOpacity = useCallback((id: OrganId, val: number) => {
    const nv = nvRef.current;
    if (!nv) return;
    const idx = ORGANS.findIndex(o => o.id === id) + 1;
    if (nv.volumes[idx] !== undefined && visible[id]) {
      nv.volumes[idx].opacity = val;
      nv.updateGLVolume();
    }
  }, [visible]);

  // ── Isolate organ (click name to solo; click again to restore all) ─────────
  const isolateOrgan = useCallback((id: OrganId) => {
    const nv = nvRef.current;
    if (!nv) return;
    const alreadyIsolated = visible[id] && ORGANS.every(o => o.id === id || !visible[o.id]);
    if (alreadyIsolated) {
      // Restore all
      setVisible(Object.fromEntries(ORGANS.map(o => [o.id, true])) as Record<OrganId, boolean>);
      ORGANS.forEach((organ, i) => {
        if (nv.volumes[i + 1] !== undefined) nv.volumes[i + 1].opacity = opacities[organ.id];
      });
    } else {
      // Solo this organ
      setVisible(Object.fromEntries(ORGANS.map(o => [o.id, o.id === id])) as Record<OrganId, boolean>);
      ORGANS.forEach((organ, i) => {
        if (nv.volumes[i + 1] !== undefined)
          nv.volumes[i + 1].opacity = organ.id === id ? opacities[organ.id] : 0;
      });
    }
    nv.updateGLVolume();
  }, [visible, opacities]);

  // ── Distance measurement mode ──────────────────────────────────────────────
  const toggleMeasure = useCallback(() => {
    const nv = nvRef.current;
    if (!nv) return;
    setIsMeasuring(prev => {
      const next = !prev;
      // NiiVue dragMode: 1 = contrast (W/L), 2 = measurement ruler
      nv.opts.dragMode = next ? 2 : 1;
      return next;
    });
  }, []);

  // ── File loading helpers ───────────────────────────────────────────────────
  const loadFileAsOverlay = useCallback(async (file: File, colormap = 'gray', opacity = 1) => {
    const nv = nvRef.current;
    if (!nv) return;
    const { NVImage } = await import('@niivue/niivue');
    const url = URL.createObjectURL(file);
    const vol = await NVImage.loadFromUrl({ url, colormap, opacity, cal_min: NaN, cal_max: NaN });
    nv.addVolume(vol);
    URL.revokeObjectURL(url);
  }, []);

  const handleCTFile = useCallback(async (file: File) => {
    const nv = nvRef.current;
    if (!nv) return;
    const { NVImage } = await import('@niivue/niivue');
    const url = URL.createObjectURL(file);
    // Replace the base CT (index 0)
    const vol = await NVImage.loadFromUrl({ url, colormap: 'gray', opacity: 1, cal_min: -160, cal_max: 240 });
    if (nv.volumes[0]) {
      nv.volumes[0] = vol;
      nv.updateGLVolume();
    } else {
      nv.addVolume(vol);
    }
    URL.revokeObjectURL(url);
  }, []);

  const handleMaskFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      const colormap = DROP_COLORS[dropColorIdx.current % DROP_COLORS.length];
      dropColorIdx.current++;
      await loadFileAsOverlay(file, colormap, 0.6);
    }
  }, [loadFileAsOverlay]);

  // ── Screenshot ────────────────────────────────────────────────────────────
  const takeScreenshot = useCallback(() => {
    const nv     = nvRef.current;
    const canvas = canvasRef.current;
    if (!canvas || !nv) return;
    // WebGL canvases may have an empty back-buffer if preserveDrawingBuffer is
    // false (the default). Force NiiVue to redraw synchronously so toDataURL
    // captures the live scene rather than a blank frame.
    nv.drawScene?.();
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `bodymaps-${new Date().toISOString().slice(0,10)}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, []);

  // ── Drag & drop ────────────────────────────────────────────────────────────
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => setIsDragOver(false), []);

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter(
      f => f.name.endsWith('.nii.gz') || f.name.endsWith('.nii')
    );
    if (!files.length) return;
    // Single file → prompt: CT or mask? For simplicity, treat as mask overlay
    // Multiple files → treat all as masks
    if (files.length === 1 && window.confirm(`Load "${files[0].name}" as CT scan? (Cancel = add as mask overlay)`)) {
      await handleCTFile(files[0]);
    } else {
      await handleMaskFiles(files);
    }
  }, [handleCTFile, handleMaskFiles]);

  // ── Render ──────────────────────────────────────────────────────────────────
  const allVisible = ORGANS.every(o => visible[o.id]);
  const noneVisible = ORGANS.every(o => !visible[o.id]);

  return (
    <div className="flex flex-col h-screen bg-[#09090f] text-white select-none">

      {/* ── Top bar ── */}
      <header className="flex items-center gap-3 px-4 h-11 bg-[#111827] border-b border-gray-800 shrink-0">
        {/* Logo */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-6 h-6 rounded bg-blue-600 flex items-center justify-center text-[10px] font-bold">BM</div>
          <span className="text-sm font-semibold">BodyMaps Viewer</span>
          <span className="text-xs text-gray-500 hidden sm:block">· JHU CCVL</span>
        </div>

        <div className="w-px h-5 bg-gray-700 mx-1" />

        {/* View mode switcher (mirrors Slicer toolbar layout buttons) */}
        <div className="flex items-center gap-1">
          {VIEW_MODES.map(v => (
            <button
              key={v.id}
              onClick={() => applyViewMode(v.id)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                viewMode === v.id
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 hover:bg-gray-700 text-gray-400'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-gray-700 mx-1" />

        {/* W/L presets */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-gray-500 mr-1 hidden md:block">CT Window:</span>
          {WL_PRESETS.map(p => (
            <button
              key={p.name}
              onClick={() => applyPreset(p)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                activePreset === p.name
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-800 hover:bg-gray-700 text-gray-400'
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>

        {/* Right-side header actions */}
        <div className="ml-auto flex items-center gap-1">
          {/* Distance measurement toggle */}
          <button
            onClick={toggleMeasure}
            title={isMeasuring ? 'Exit measurement mode (left-drag to measure)' : 'Measure distance (left-drag on image)'}
            className={`p-1.5 rounded transition-colors ${
              isMeasuring
                ? 'bg-yellow-500/20 text-yellow-400 ring-1 ring-yellow-500/50'
                : 'hover:bg-gray-700 text-gray-400 hover:text-white'
            }`}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 20l18-16M5.5 17.5l1 1m3-3.5l1 1m3-3.5l1 1m3-3.5l1 1" />
            </svg>
          </button>
          {/* Screenshot */}
          <button
            onClick={takeScreenshot}
            title="Save screenshot"
            className="p-1.5 rounded hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
          {/* Controls hint */}
          <button
            onClick={() => setShowControls(v => !v)}
            title="Keyboard & mouse controls"
            className="p-1.5 rounded hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </button>
          {/* About */}
          <button
            onClick={() => setShowAbout(true)}
            title="About"
            className="p-1.5 rounded hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
        </div>
      </header>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Canvas with drag-and-drop ── */}
        <div
          className={`relative flex-1 transition-colors ${isDragOver ? 'bg-blue-950/40' : ''}`}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {/* Loading overlay */}
          {loading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-[#09090f]">
              <div className="relative mb-5">
                <div className="w-14 h-14 rounded-full border-4 border-gray-800" />
                <div className="absolute inset-0 w-14 h-14 rounded-full border-4 border-t-blue-500 animate-spin" />
              </div>
              <p className="text-sm text-gray-300 font-medium">{loadingMsg}</p>
              <p className="text-xs text-gray-600 mt-1">BDMAP_00000338 · Abdominal CT</p>
            </div>
          )}

          {/* Drag-and-drop hint overlay */}
          {isDragOver && (
            <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
              <div className="bg-blue-600/90 rounded-xl px-8 py-6 text-center shadow-2xl border border-blue-400">
                <p className="text-lg font-semibold">Drop NIfTI file</p>
                <p className="text-sm text-blue-200 mt-1">.nii or .nii.gz</p>
              </div>
            </div>
          )}

          <canvas ref={canvasRef} className="w-full h-full" />
        </div>

        {/* ── Right sidebar ── */}
        <aside className="w-56 shrink-0 bg-[#111827] border-l border-gray-800 flex flex-col overflow-y-auto text-xs">

          {/* Load your own data */}
          <section className="p-3 border-b border-gray-800">
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest block mb-2">
              Load Data
            </span>
            <div className="flex flex-col gap-1.5">
              <button
                onClick={() => ctInputRef.current?.click()}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
              >
                <span className="text-blue-400">↑</span> Replace CT scan
              </button>
              <button
                onClick={() => maskInputRef.current?.click()}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
              >
                <span className="text-green-400">↑</span> Add mask overlay
              </button>
              <p className="text-[10px] text-gray-600 mt-0.5">or drag & drop .nii.gz onto viewer</p>
            </div>
            {/* Hidden file inputs */}
            <input
              ref={ctInputRef}
              type="file"
              accept=".nii,.nii.gz"
              className="hidden"
              onChange={e => { if (e.target.files?.[0]) handleCTFile(e.target.files[0]); }}
            />
            <input
              ref={maskInputRef}
              type="file"
              accept=".nii,.nii.gz"
              multiple
              className="hidden"
              onChange={e => { if (e.target.files) handleMaskFiles(Array.from(e.target.files)); }}
            />
          </section>

          {/* Segmentations */}
          <section className="p-3 border-b border-gray-800">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-baseline gap-1">
                <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Segmentations</span>
                <span className="text-[9px] text-gray-600">mL</span>
              </div>
              {/* Show all / Hide all */}
              <div className="flex gap-1">
                <button
                  onClick={() => toggleAll(true)}
                  className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                    allVisible ? 'text-blue-400' : 'text-gray-500 hover:text-gray-300'
                  }`}
                >All</button>
                <span className="text-gray-700">·</span>
                <button
                  onClick={() => toggleAll(false)}
                  className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                    noneVisible ? 'text-blue-400' : 'text-gray-500 hover:text-gray-300'
                  }`}
                >None</button>
              </div>
            </div>

            <div className="flex flex-col gap-px">
              {ORGANS.map(organ => {
                const on  = visible[organ.id];
                const stat = organStats[organ.id];
                const op  = opacities[organ.id];
                return (
                  <div
                    key={organ.id}
                    className={`rounded px-1.5 py-1 transition-colors ${on ? 'bg-gray-800/60' : ''}`}
                  >
                    {/* Row: eye · [name + stats — click to isolate] */}
                    <div className="flex items-center gap-1.5">
                      {/* Eye: toggle visibility */}
                      <button
                        onClick={() => toggleOrgan(organ.id)}
                        title={on ? 'Hide' : 'Show'}
                        className={`shrink-0 transition-colors ${on ? 'text-gray-300 hover:text-white' : 'text-gray-600 hover:text-gray-400'}`}
                      >
                        {on ? (
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </svg>
                        ) : (
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                          </svg>
                        )}
                      </button>
                      {/* Name + stats: click to isolate / un-isolate */}
                      <button
                        onClick={() => isolateOrgan(organ.id)}
                        title="Click to isolate · click again to restore all"
                        className="flex flex-1 items-center gap-1.5 min-w-0 text-left hover:opacity-80 transition-opacity"
                      >
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: organ.hex, opacity: on ? 1 : 0.3 }} />
                        <div className="flex-1 min-w-0">
                          <div className={`text-xs truncate ${on ? 'text-white' : 'text-gray-600'}`}>{organ.name}</div>
                          {stat && on && (
                            <div className="text-[9px] font-mono tabular-nums leading-tight">
                              <span style={{ color: organ.hex }}>{stat.volumeMl.toLocaleString()} mL</span>
                              {stat.meanHU !== 0 && (
                                <span className="text-gray-500 ml-1">{stat.meanHU} HU</span>
                              )}
                            </div>
                          )}
                        </div>
                      </button>
                    </div>
                    {/* Per-organ opacity slider — only when visible */}
                    {on && (
                      <div className="flex items-center gap-1.5 mt-0.5 pl-5">
                        <input
                          type="range" min={0.05} max={1} step={0.05} value={op}
                          onChange={e => setOpacities(prev => ({ ...prev, [organ.id]: parseFloat(e.target.value) }))}
                          onPointerUp={e => commitOrganOpacity(organ.id, parseFloat((e.target as HTMLInputElement).value))}
                          className="organ-slider flex-1"
                          style={{ '--thumb-color': organ.hex } as React.CSSProperties}
                        />
                        <span className="text-[9px] text-gray-600 w-6 text-right shrink-0 tabular-nums">
                          {Math.round(op * 100)}%
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {Object.keys(organStats).length === 0 && !loading && (
              <p className="text-[10px] text-gray-600 mt-2 px-1">Computing volumes…</p>
            )}
          </section>

          {/* ── Data Probe (from Slicer PDF slide 8) ── */}
          <section className="p-3 border-b border-gray-800">
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest block mb-2">
              Data Probe
            </span>
            {probe.hu !== null ? (
              <div className="flex flex-col gap-1 font-mono">
                <div className="flex justify-between">
                  <span className="text-gray-500">HU</span>
                  <span className="text-white">{probe.hu}</span>
                </div>
                {probe.mm.length >= 3 && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">R</span>
                    <span className="text-gray-300">{probe.mm[0]?.toFixed(1)} mm</span>
                  </div>
                )}
                {probe.mm.length >= 3 && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">A</span>
                    <span className="text-gray-300">{probe.mm[1]?.toFixed(1)} mm</span>
                  </div>
                )}
                {probe.mm.length >= 3 && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">S</span>
                    <span className="text-gray-300">{probe.mm[2]?.toFixed(1)} mm</span>
                  </div>
                )}
                {probe.vox.length >= 3 && (
                  <div className="flex justify-between mt-0.5">
                    <span className="text-gray-500">Vox</span>
                    <span className="text-gray-500 text-[10px]">
                      {probe.vox.slice(0,3).map(Math.round).join(', ')}
                    </span>
                  </div>
                )}
                {spacing && (
                  <div className="flex justify-between mt-0.5">
                    <span className="text-gray-500">Sp</span>
                    <span className="text-gray-500 text-[10px]">
                      {spacing.join(' × ')} mm
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[10px] text-gray-600">Move crosshair over image</p>
            )}
          </section>

          {/* Footer */}
          <div className="mt-auto p-3">
            <p className="text-[10px] text-gray-600 leading-relaxed">
              Johns Hopkins University<br />
              Computational Cognition,<br />
              Vision &amp; Learning Lab
            </p>
          </div>
        </aside>
      </div>

      {/* ── Controls overlay ── */}
      {showControls && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/60"
          onClick={() => setShowControls(false)}
        >
          <div
            className="bg-[#1a2235] border border-gray-700 rounded-xl p-6 w-80 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white">Mouse &amp; Keyboard Controls</h2>
              <button onClick={() => setShowControls(false)} className="text-gray-500 hover:text-white text-lg leading-none">×</button>
            </div>
            <div className="flex flex-col gap-2 text-xs">
              {[
                ['Left click/drag', 'Move crosshair (2D) · Rotate (3D)'],
                ['Right drag',      'Adjust brightness / contrast (W/L)'],
                ['Scroll wheel',    'Scroll through slices'],
                ['Double-click',    'Reset view'],
                ['Drag & drop',     'Load .nii.gz file'],
              ].map(([key, val]) => (
                <div key={key} className="flex justify-between gap-3">
                  <span className="text-gray-400 font-mono bg-gray-800 px-2 py-0.5 rounded shrink-0">{key}</span>
                  <span className="text-gray-300 text-right">{val}</span>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-gray-600 mt-3 leading-relaxed">
              Tip: use the CT Window presets to reset brightness after adjusting.
            </p>
          </div>
        </div>
      )}

      {/* ── About modal ── */}
      {showAbout && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/60"
          onClick={() => setShowAbout(false)}
        >
          <div
            className="bg-[#1a2235] border border-gray-700 rounded-xl p-6 w-96 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded bg-blue-600 flex items-center justify-center text-xs font-bold">BM</div>
                <h2 className="text-sm font-semibold text-white">BodyMaps Viewer</h2>
              </div>
              <button onClick={() => setShowAbout(false)} className="text-gray-500 hover:text-white text-lg leading-none">×</button>
            </div>
            <div className="flex flex-col gap-3 text-xs text-gray-400 leading-relaxed">
              <p>
                A web-based CT scan viewer with per-voxel organ segmentation overlays,
                built for the <span className="text-white">BodyMaps Program</span> at
                Johns Hopkins University.
              </p>
              <p>
                Visualizes NIfTI (.nii.gz) CT volumes and multi-label segmentation masks
                directly in the browser using WebGL — no installation required.
              </p>
              <div className="border-t border-gray-700 pt-3">
                <p className="text-gray-500 mb-1 font-semibold uppercase tracking-widest text-[10px]">Sample Data</p>
                <p>BDMAP_00000338 · Abdominal CT</p>
                <p>9 annotated structures: liver, spleen, pancreas, kidneys, aorta, stomach, postcava, gallbladder</p>
              </div>
              <div className="border-t border-gray-700 pt-3">
                <p className="text-gray-500 mb-1 font-semibold uppercase tracking-widest text-[10px]">Built With</p>
                <p>NiiVue · Next.js · WebGL2</p>
              </div>
              <div className="border-t border-gray-700 pt-3 text-gray-500">
                <p>Computational Cognition, Vision &amp; Learning Lab</p>
                <p>Johns Hopkins University · CCVL</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
