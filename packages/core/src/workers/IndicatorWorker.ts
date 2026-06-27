self.onmessage = (event: MessageEvent) => {
  const { type, data } = event.data;

  switch (type) {
    case 'compute': {
      const { indicator, prices, volumes } = data as {
        indicator: string;
        prices: Float64Array;
        volumes: Float64Array;
        params: Record<string, number>;
      };
      const result = computeIndicator(indicator, prices, volumes);
      self.postMessage({ type: 'result', data: result }, { transfer: [result.buffer] });
      break;
    }
  }
};

function computeIndicator(indicator: string, prices: Float64Array, volumes: Float64Array): Float64Array {
  switch (indicator) {
    case 'sma': {
      const period = 14;
      const result = new Float64Array(prices.length);
      for (let i = period - 1; i < prices.length; i++) {
        let sum = 0;
        for (let j = 0; j < period; j++) sum += prices[i - j];
        result[i] = sum / period;
      }
      return result;
    }
    case 'ema': {
      const period = 14;
      const alpha = 2 / (period + 1);
      const result = new Float64Array(prices.length);
      result[0] = prices[0];
      for (let i = 1; i < prices.length; i++) {
        result[i] = alpha * prices[i] + (1 - alpha) * result[i - 1];
      }
      return result;
    }
    default:
      return new Float64Array(prices.length);
  }
}
