import { useCallback, useEffect, useRef, useState } from 'react';
import { deviceService } from '@/services/deviceService';
import { AudioRecording, HiDockDevice } from '@/types';

const RECONNECT_KEY = 'openhinotes_bridge_device_connected';

export function useDeviceConnection() {
  const [device, setDevice] = useState<HiDockDevice | null>(null);
  const [recordings, setRecordings] = useState<AudioRecording[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const isInitializing = useRef(false);

  useEffect(() => {
    const initializeDevice = async () => {
      if (isInitializing.current || device?.connected) return;
      if (localStorage.getItem(RECONNECT_KEY) !== 'true') return;

      isInitializing.current = true;
      try {
        const devices = await navigator.usb.getDevices();
        if (devices.length > 0) {
          const hiDockDevice = await deviceService.connectDevice(devices[0]);
          setDevice(hiDockDevice);
        }
      } catch (err) {
        console.error('Failed to reconnect to device:', err);
      } finally {
        isInitializing.current = false;
      }
    };

    initializeDevice();
  }, [device?.connected]);

  const connectDevice = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const usbDevice = await deviceService.requestDevice();
      const hiDockDevice = await deviceService.connectDevice(usbDevice);
      setDevice(hiDockDevice);
      localStorage.setItem(RECONNECT_KEY, 'true');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect device');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const disconnectDevice = useCallback(async () => {
    try {
      await deviceService.disconnectDevice();
      setDevice(null);
      setRecordings([]);
      localStorage.removeItem(RECONNECT_KEY);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect device');
    }
  }, []);

  const refreshRecordings = useCallback(async () => {
    if (!deviceService.isConnected()) {
      setError('Device not connected');
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const list = await deviceService.getFileList();
      setRecordings(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh recordings');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const downloadRecording = useCallback(
    async (
      fileName: string,
      fileSize: number,
      onProgress?: (percent: number) => void,
      fileVersion?: number,
    ): Promise<Blob | null> => {
      if (!deviceService.isConnected()) {
        setError('Device not connected');
        return null;
      }
      setError(null);
      try {
        const cached = deviceService.getCachedBlob(fileName);
        if (cached) return cached;
        const blob = await deviceService.downloadFile(fileName, fileSize, onProgress, fileVersion);
        deviceService.setCachedBlob(fileName, blob);
        return blob;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to download recording');
        return null;
      }
    },
    [],
  );

  const deleteRecording = useCallback(
    async (fileName: string) => {
      if (!deviceService.isConnected()) {
        setError('Device not connected');
        return;
      }
      setIsLoading(true);
      setError(null);
      try {
        await deviceService.deleteFile(fileName);
        await refreshRecordings();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete recording');
      } finally {
        setIsLoading(false);
      }
    },
    [refreshRecordings],
  );

  const syncTime = useCallback(async () => {
    if (!deviceService.isConnected()) {
      setError('Device not connected');
      return;
    }
    setError(null);
    try {
      await deviceService.syncTime();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync time');
    }
  }, []);

  return {
    device,
    recordings,
    error,
    isLoading,
    connectDevice,
    disconnectDevice,
    refreshRecordings,
    downloadRecording,
    deleteRecording,
    syncTime,
    clearError: () => setError(null),
  };
}
