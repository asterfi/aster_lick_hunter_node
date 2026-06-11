/**
 * Request Interceptor for API calls
 *
 * Wraps all axios calls to go through the rate limiter
 * Automatically parses response headers to update rate limit counters
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { getRateLimitManager, RequestPriority } from './rateLimitManager';

// Endpoint weight mapping based on API documentation
const ENDPOINT_WEIGHTS: Record<string, number> = {
  // Market Data
  '/fapi/v3/ping': 1,
  '/fapi/v3/time': 1,
  '/fapi/v3/exchangeInfo': 1,
  '/fapi/v3/depth': 2, // Default, can be 5, 10, or 20 based on limit
  '/fapi/v3/trades': 1,
  '/fapi/v3/historicalTrades': 20,
  '/fapi/v3/aggTrades': 20,
  '/fapi/v3/klines': 1, // Default, can be up to 10
  '/fapi/v3/premiumIndex': 1,
  '/fapi/v3/fundingRate': 1,
  '/fapi/v3/ticker/24hr': 1, // Single symbol, 40 for all
  '/fapi/v3/ticker/price': 1, // Single symbol, 2 for all
  '/fapi/v3/ticker/bookTicker': 1, // Single symbol, 2 for all

  // Account/Trade
  '/fapi/v3/positionSide/dual': 30,
  '/fapi/v3/multiAssetsMargin': 1,
  '/fapi/v3/order': 1,
  '/fapi/v3/batchOrders': 5,
  '/fapi/v3/allOpenOrders': 1,
  '/fapi/v3/openOrder': 1,
  '/fapi/v3/openOrders': 1, // Single symbol, 40 for all
  '/fapi/v3/allOrders': 5,
  '/fapi/v3/balance': 5,
  '/fapi/v3/account': 5,
  '/fapi/v3/leverage': 1,
  '/fapi/v3/marginType': 1,
  '/fapi/v3/positionMargin': 1,
  '/fapi/v3/positionRisk': 5,
  '/fapi/v3/userTrades': 5,
  '/fapi/v3/income': 30,
  '/fapi/v3/leverageBracket': 1,
  '/fapi/v3/listenKey': 1,
  '/fapi/v3/apiTradingStatus': 1,
  '/fapi/v3/commissionRate': 20,
};

// Priority mapping for endpoints
const ENDPOINT_PRIORITIES: Record<string, RequestPriority> = {
  // Critical - Orders
  '/fapi/v3/order': RequestPriority.CRITICAL,
  '/fapi/v3/batchOrders': RequestPriority.CRITICAL,
  '/fapi/v3/allOpenOrders': RequestPriority.CRITICAL,

  // High - Position management
  '/fapi/v3/positionRisk': RequestPriority.HIGH,
  '/fapi/v3/leverage': RequestPriority.HIGH,
  '/fapi/v3/marginType': RequestPriority.HIGH,
  '/fapi/v3/positionMargin': RequestPriority.HIGH,

  // Medium - Account info
  '/fapi/v3/balance': RequestPriority.MEDIUM,
  '/fapi/v3/account': RequestPriority.MEDIUM,
  '/fapi/v3/openOrders': RequestPriority.MEDIUM,

  // Low - Market data
  '/fapi/v3/depth': RequestPriority.LOW,
  '/fapi/v3/ticker/24hr': RequestPriority.LOW,
  '/fapi/v3/ticker/price': RequestPriority.LOW,
  '/fapi/v3/klines': RequestPriority.LOW,
};

export interface RateLimitedAxiosInstance extends AxiosInstance {
  rateLimitManager: ReturnType<typeof getRateLimitManager>;
}

/**
 * Create a rate-limited axios instance
 */
export function createRateLimitedAxios(baseURL: string = 'https://fapi.asterdex.com'): RateLimitedAxiosInstance {
  const instance = axios.create({
    baseURL,
    timeout: 10000,  // Default timeout, will be overridden for specific endpoints
  }) as RateLimitedAxiosInstance;

  const rateLimitManager = getRateLimitManager();
  instance.rateLimitManager = rateLimitManager;

  // Request interceptor
  instance.interceptors.request.use(
    async (config: InternalAxiosRequestConfig) => {
      // Extract endpoint from URL
      const url = config.url || '';
      const endpoint = url.split('?')[0];

      // Determine weight and priority
      let weight = ENDPOINT_WEIGHTS[endpoint] || 1;
      const priority = ENDPOINT_PRIORITIES[endpoint] || RequestPriority.MEDIUM;
      const isOrder = endpoint === '/fapi/v3/order' || endpoint === '/fapi/v3/batchOrders';

      // Use longer timeout for order endpoints to handle queue delays
      if (isOrder) {
        config.timeout = 20000; // 20 seconds for order placement
      }

      // Adjust weight for special cases
      if (endpoint === '/fapi/v3/depth') {
        const limit = parseInt(config.params?.limit || '500');
        if (limit <= 50) weight = 2;
        else if (limit <= 100) weight = 5;
        else if (limit <= 500) weight = 10;
        else weight = 20;
      }

      if (endpoint === '/fapi/v3/klines') {
        const limit = parseInt(config.params?.limit || '500');
        if (limit < 100) weight = 1;
        else if (limit < 500) weight = 2;
        else if (limit <= 1000) weight = 5;
        else weight = 10;
      }

      // Check if symbol is omitted (increases weight for some endpoints)
      const noSymbol = !config.params?.symbol && !config.data?.symbol;
      if (noSymbol) {
        if (endpoint === '/fapi/v3/ticker/24hr') weight = 40;
        if (endpoint === '/fapi/v3/ticker/price') weight = 2;
        if (endpoint === '/fapi/v3/ticker/bookTicker') weight = 2;
        if (endpoint === '/fapi/v3/openOrders') weight = 40;
      }

      // Store metadata for response interceptor
      (config as any).rateLimitMeta = { weight, priority, isOrder };

      return config;
    },
    (error: AxiosError) => Promise.reject(error)
  );

  // Response interceptor
  instance.interceptors.response.use(
    (response: AxiosResponse) => {
      // Update rate limit manager with response headers
      rateLimitManager.updateFromHeaders(response.headers);

      return response;
    },
    async (error: AxiosError) => {
      if (error.response?.status === 429) {
        console.error('Rate limit hit (429):', error.config?.url);
        // Rate limit manager will handle backoff via executeRequest
      }

      // Update headers even on error
      if (error.response?.headers) {
        rateLimitManager.updateFromHeaders(error.response.headers);
      }

      return Promise.reject(error);
    }
  );

  // Store original methods
  const originalGet = instance.get.bind(instance);
  const originalPost = instance.post.bind(instance);
  const originalPut = instance.put.bind(instance);
  const originalDelete = instance.delete.bind(instance);

  // Override GET method
  instance.get = async function<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    // Extract endpoint from URL for weight calculation
    // Handle both relative and absolute URLs
    let endpoint = url.split('?')[0];
    if (endpoint.startsWith('http')) {
      // Extract path from full URL
      const urlObj = new URL(endpoint);
      endpoint = urlObj.pathname;
    } else if (endpoint.startsWith(baseURL)) {
      endpoint = endpoint.replace(baseURL, '');
    }

    const weight = ENDPOINT_WEIGHTS[endpoint] || 1;
    const priority = ENDPOINT_PRIORITIES[endpoint] || RequestPriority.MEDIUM;
    const isOrder = false;


    return rateLimitManager.executeRequest(
      () => originalGet<T>(url, config),
      weight,
      isOrder,
      priority
    );
  } as any;

  // Override POST method
  instance.post = async function<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    // Extract endpoint from URL for weight calculation
    let endpoint = url.split('?')[0];
    if (endpoint.startsWith('http')) {
      const urlObj = new URL(endpoint);
      endpoint = urlObj.pathname;
    } else if (endpoint.startsWith(baseURL)) {
      endpoint = endpoint.replace(baseURL, '');
    }

    const weight = ENDPOINT_WEIGHTS[endpoint] || 1;
    const priority = ENDPOINT_PRIORITIES[endpoint] || RequestPriority.MEDIUM;
    const isOrder = endpoint === '/fapi/v3/order' || endpoint === '/fapi/v3/batchOrders';

    return rateLimitManager.executeRequest(
      () => originalPost<T>(url, data, config),
      weight,
      isOrder,
      priority
    );
  } as any;

  // Override PUT method
  instance.put = async function<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    let endpoint = url.split('?')[0];
    if (endpoint.startsWith('http')) {
      const urlObj = new URL(endpoint);
      endpoint = urlObj.pathname;
    } else if (endpoint.startsWith(baseURL)) {
      endpoint = endpoint.replace(baseURL, '');
    }

    const weight = ENDPOINT_WEIGHTS[endpoint] || 1;
    const priority = ENDPOINT_PRIORITIES[endpoint] || RequestPriority.MEDIUM;
    const isOrder = false;

    return rateLimitManager.executeRequest(
      () => originalPut<T>(url, data, config),
      weight,
      isOrder,
      priority
    );
  } as any;

  // Override DELETE method
  instance.delete = async function<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    let endpoint = url.split('?')[0];
    if (endpoint.startsWith('http')) {
      const urlObj = new URL(endpoint);
      endpoint = urlObj.pathname;
    } else if (endpoint.startsWith(baseURL)) {
      endpoint = endpoint.replace(baseURL, '');
    }

    const weight = ENDPOINT_WEIGHTS[endpoint] || 1;
    const priority = ENDPOINT_PRIORITIES[endpoint] || RequestPriority.HIGH; // DELETE is usually important
    const isOrder = endpoint === '/fapi/v3/order' || endpoint === '/fapi/v3/allOpenOrders';

    return rateLimitManager.executeRequest(
      () => originalDelete<T>(url, config),
      weight,
      isOrder,
      priority
    );
  } as any;

  return instance;
}

// Create default instance
let defaultInstance: RateLimitedAxiosInstance | null = null;

export function getRateLimitedAxios(): RateLimitedAxiosInstance {
  if (!defaultInstance) {
    defaultInstance = createRateLimitedAxios();
  }
  return defaultInstance;
}

/**
 * Helper to make rate-limited requests
 */
export async function rateLimitedRequest<T = any>(
  config: AxiosRequestConfig & {
    weight?: number;
    priority?: RequestPriority;
    isOrder?: boolean;
  }
): Promise<AxiosResponse<T>> {
  const instance = getRateLimitedAxios();
  const rateLimitManager = instance.rateLimitManager;

  const weight = config.weight || 1;
  const priority = config.priority || RequestPriority.MEDIUM;
  const isOrder = config.isOrder || false;

  return rateLimitManager.executeRequest(
    async () => {
      const response = await axios.request<T>(config);
      rateLimitManager.updateFromHeaders(response.headers);
      return response;
    },
    weight,
    isOrder,
    priority
  );
}