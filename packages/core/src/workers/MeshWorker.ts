self.onmessage = (event: MessageEvent) => {
  const { type, data } = event.data;

  switch (type) {
    case 'generateBars': {
      const { bars, priceRange } = data;
      const positions = new Float32Array(bars.length * 24 * 3);
      const colors = new Float32Array(bars.length * 24 * 3);
      const indices = new Uint32Array(bars.length * 36);

      for (let i = 0; i < bars.length; i++) {
        const bar = bars[i];
        const baseIdx = i * 24;
        const isBull = bar.close >= bar.open;

        for (let j = 0; j < 8; j++) {
          positions[(baseIdx + j) * 3] = i;
          positions[(baseIdx + j) * 3 + 1] = bar.low + (bar.high - bar.low) * (j / 8);
          positions[(baseIdx + j) * 3 + 2] = 0;
        }
        for (let j = 0; j < 24; j++) {
          colors[(baseIdx + j) * 3] = isBull ? 0.2 : 0.8;
          colors[(baseIdx + j) * 3 + 1] = isBull ? 0.8 : 0.15;
          colors[(baseIdx + j) * 3 + 2] = isBull ? 0.5 : 0.2;
        }
        for (let j = 0; j < 36; j++) {
          indices[i * 36 + j] = i * 24 + (j % 24);
        }
      }

      self.postMessage(
        { type: 'meshData', data: { positions, colors, indices } },
        { transfer: [positions.buffer, colors.buffer, indices.buffer] },
      );
      break;
    }
  }
};
