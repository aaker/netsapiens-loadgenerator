jest.mock('axios');

const axios = require('axios');

// Mock axios.create to return a mock instance
const mockRequest = jest.fn();
const mockAxiosInstance = { request: mockRequest };
axios.create.mockReturnValue(mockAxiosInstance);

const { ServerApiClient } = require('../../lib/nsapi');

describe('ServerApiClient', () => {
  let client;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new ServerApiClient({
      hostname: 'test.example.com',
      apikey: 'testkey123',
      id: 'test-server'
    });
  });

  describe('constructor', () => {
    test('stores config values', () => {
      expect(client.hostname).toBe('test.example.com');
      expect(client.apikey).toBe('testkey123');
      expect(client.serverId).toBe('test-server');
    });
  });

  describe('_retryApiCall', () => {
    test('succeeds on first try', async () => {
      const apiCall = jest.fn().mockResolvedValue({ data: 'ok' });
      const result = await client._retryApiCall(apiCall);
      expect(result).toEqual({ data: 'ok' });
      expect(apiCall).toHaveBeenCalledTimes(1);
    });

    test('retries on ECONNRESET', async () => {
      const error = new Error('connection reset');
      error.code = 'ECONNRESET';
      const apiCall = jest.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ data: 'ok' });

      const result = await client._retryApiCall(apiCall);

      expect(result).toEqual({ data: 'ok' });
      expect(apiCall).toHaveBeenCalledTimes(2);
    }, 15000);

    test('retries on HTTP 500+', async () => {
      const error = new Error('server error');
      error.response = { status: 503 };
      const apiCall = jest.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ data: 'ok' });

      const result = await client._retryApiCall(apiCall);

      expect(result).toEqual({ data: 'ok' });
      expect(apiCall).toHaveBeenCalledTimes(2);
    }, 15000);

    test('does NOT retry on HTTP 400', async () => {
      const error = new Error('bad request');
      error.response = { status: 400 };
      const apiCall = jest.fn().mockRejectedValue(error);

      await expect(client._retryApiCall(apiCall)).rejects.toThrow('bad request');
      expect(apiCall).toHaveBeenCalledTimes(1);
    });

    test('does NOT retry on HTTP 409', async () => {
      const error = new Error('conflict');
      error.response = { status: 409 };
      const apiCall = jest.fn().mockRejectedValue(error);

      await expect(client._retryApiCall(apiCall)).rejects.toThrow('conflict');
      expect(apiCall).toHaveBeenCalledTimes(1);
    });

    test('throws after max retries exhausted', async () => {
      const error = new Error('timeout');
      error.code = 'ETIMEDOUT';
      const apiCall = jest.fn().mockRejectedValue(error);

      await expect(client._retryApiCall(apiCall, 1)).rejects.toThrow('timeout');
      expect(apiCall).toHaveBeenCalledTimes(2); // initial + 1 retry
    }, 15000);
  });

  describe('apiCreate', () => {
    test('calls POST with correct URL and headers', async () => {
      mockRequest.mockResolvedValue({ status: 201, statusText: 'Created' });

      const successFn = jest.fn();
      await client.apiCreate('domains', { name: 'test.com' }, successFn);

      expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST',
        url: 'https://test.example.com/ns-api/v2/domains',
        headers: expect.objectContaining({
          authorization: 'Bearer testkey123'
        }),
        data: { name: 'test.com' }
      }));
      expect(successFn).toHaveBeenCalledWith({ name: 'test.com' });
    });

    test('calls duplicateFunction then successFunction on 409', async () => {
      const error = new Error('conflict');
      error.response = { status: 409, statusText: 'Conflict' };
      mockRequest.mockRejectedValue(error);

      const successFn = jest.fn();
      const dupFn = jest.fn();
      await client.apiCreate('domains', { name: 'dup.com' }, successFn, dupFn);

      expect(dupFn).toHaveBeenCalledWith({ name: 'dup.com' });
      expect(successFn).toHaveBeenCalledWith({ name: 'dup.com' });
    });

    test('handles missing callbacks gracefully', async () => {
      mockRequest.mockResolvedValue({ status: 201, statusText: 'Created' });
      // Should not throw
      await expect(client.apiCreate('domains', { name: 'test.com' })).resolves.toBeUndefined();
    });
  });

  describe('apiUpdate', () => {
    test('calls PUT with correct URL and headers', async () => {
      mockRequest.mockResolvedValue({ status: 200, statusText: 'OK' });

      const successFn = jest.fn();
      await client.apiUpdate('domains/test.com', { description: 'updated' }, successFn);

      expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
        method: 'PUT',
        url: 'https://test.example.com/ns-api/v2/domains/test.com',
        data: { description: 'updated' }
      }));
      expect(successFn).toHaveBeenCalled();
    });

    test('handles errors without throwing', async () => {
      const error = new Error('bad request');
      error.response = { status: 400, statusText: 'Bad Request' };
      mockRequest.mockRejectedValue(error);

      // apiUpdate catches errors, should not throw (non-retryable error)
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      await expect(client.apiUpdate('domains/test.com', {})).resolves.toBeUndefined();
      consoleSpy.mockRestore();
    });
  });

  describe('apiCountSync', () => {
    test('returns total on success', async () => {
      mockRequest.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: { total: 42 }
      });

      const result = await client.apiCountSync('domains?format=count');
      expect(result).toBe(42);
    });

    test('returns 0 on error', async () => {
      mockRequest.mockRejectedValue(new Error('network error'));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      const result = await client.apiCountSync('domains?format=count');
      expect(result).toBe(0);
      consoleSpy.mockRestore();
    });

    test('returns 0 when response.data.total is missing', async () => {
      mockRequest.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: {}
      });

      const result = await client.apiCountSync('domains?format=count');
      expect(result).toBe(0);
    });
  });

  describe('apiCreateSync', () => {
    test('calls successFunction on success', async () => {
      mockRequest.mockResolvedValue({ status: 201, statusText: 'Created' });

      const successFn = jest.fn();
      await client.apiCreateSync('users', { name: 'test' }, successFn);
      expect(successFn).toHaveBeenCalled();
    });

    test('calls duplicateFunction on 409', async () => {
      const error = new Error('conflict');
      error.response = { status: 409, statusText: 'Conflict' };
      mockRequest.mockRejectedValue(error);

      const dupFn = jest.fn();
      await client.apiCreateSync('users', { name: 'test' }, jest.fn(), dupFn);
      expect(dupFn).toHaveBeenCalled();
    });
  });
});
