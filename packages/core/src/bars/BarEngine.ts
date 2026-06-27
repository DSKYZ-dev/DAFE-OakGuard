import type { BaseBar, Tick, BarParams, BarGeometry, Scale, ParameterDefinition, BarCategory, BarTypeId } from '@dafe/types';

export interface BarEngine<TBar extends BaseBar = BaseBar> {
  readonly id: BarTypeId;
  readonly category: BarCategory;
  readonly requiresTicks: boolean;
  readonly is3DCapable: boolean;

  aggregate(ticks: Tick[], params: BarParams): TBar[];
  updateLast(bar: TBar, tick: Tick): TBar;

  getGeometry(bar: TBar, scale: Scale): BarGeometry;
  getShader?(): string;

  getParameters(): ParameterDefinition[];
}
