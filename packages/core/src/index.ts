// Engine
export { Renderer } from './engine/Renderer';
export type { RendererBackend } from './engine/Renderer';
export { Compositor } from './engine/Compositor';
export { SceneGraph } from './engine/SceneGraph';
export { RenderLoop } from './engine/RenderLoop';
export { WebGPURenderer } from './engine/WebGPURenderer';
export { WebGL2Renderer } from './engine/WebGL2Renderer';
export { Canvas2DRenderer } from './engine/Canvas2DRenderer';
export { ThreeRenderer } from './engine/ThreeRenderer';

// Bars
export { BarRegistry } from './bars/BarRegistry';
export type { BarEngine } from './bars/BarEngine';
export { CandlestickEngine } from './bars/engines/CandlestickEngine';
export { HeikinAshiEngine } from './bars/engines/HeikinAshiEngine';
export { RenkoEngine } from './bars/engines/RenkoEngine';
export { RangeBarEngine } from './bars/engines/RangeBarEngine';
export { VolumeBarEngine } from './bars/engines/VolumeBarEngine';
export { TickBarEngine } from './bars/engines/TickBarEngine';
export { KagiEngine } from './bars/engines/KagiEngine';
export { FootprintEngine } from './bars/engines/FootprintEngine';
export { LineEngine } from './bars/engines/LineEngine';
export { AreaEngine } from './bars/engines/AreaEngine';

// Volume
export { VolumeProfileLayer } from './volume/VolumeProfileLayer';
export { VolumeBinner } from './volume/VolumeBinner';
export { POCCalculator } from './volume/POCCalculator';
export { ValueAreaCalculator } from './volume/ValueAreaCalculator';

// 3D
export { Scene3D } from './three-d/Scene3D';
export { CameraController } from './three-d/CameraController';
export { LightingRig } from './three-d/LightingRig';
export { MeshGenerator } from './three-d/MeshGenerator';
export { PostProcessing } from './three-d/PostProcessing';
export { ModeTransition } from './three-d/ModeTransition';

// Layers
export { Layer } from './layers/Layer';
export { BackgroundLayer } from './layers/BackgroundLayer';
export { GridLayer } from './layers/GridLayer';
export { BarsLayer } from './layers/BarsLayer';
export { VolumeLayer } from './layers/VolumeLayer';
export { IndicatorLayer } from './layers/IndicatorLayer';
export { DrawingLayer } from './layers/DrawingLayer';
export { UILayer } from './layers/UILayer';
export type { Drawing } from './layers/DrawingLayer';
export type { UIElement } from './layers/UILayer';
export type { IndicatorOverlay } from './layers/IndicatorLayer';

// Data
export { TickStream } from './data/TickStream';
export { BarCollection } from './data/BarCollection';
export { SharedBufferManager } from './data/SharedBuffer';
export { ArrowTable } from './data/ArrowTable';
export { WebSocketProvider } from './data/providers/WebSocketProvider';

// Strategies
export { DVSEngine, type DVSState } from './strategies/dvs-engine';
export { MarketStructureEngine, type SwingPoint, type ProfileLevels, type StructureState, type ConfluenceZone, type IntrabarState, type MarketContext } from './strategies/market-structure';
export { RCMEngine, type RCMPreset, type RCMConfig, type RCMState, type RCMPermissions, type RCMModulation } from './strategies/rcm-engine';
export { AdaptiveGenesisEngine, DEFAULT_AGE_CONFIG, type AGEConfig, type Strategy, type SignalResult } from './strategies/adaptive-genesis-engine';

// Interaction
export { MouseController } from './interaction/MouseController';
export { KeyboardController } from './interaction/KeyboardController';
export type { MouseState } from './interaction/MouseController';
export type { KeyboardShortcut } from './interaction/KeyboardController';
export { Raycaster } from './interaction/Raycaster';
export type { RaycastHit } from './interaction/Raycaster';
export { Crosshair } from './interaction/Crosshair';
export type { CrosshairState } from './interaction/Crosshair';
export { TouchController } from './interaction/TouchController';
