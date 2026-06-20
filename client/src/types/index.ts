export interface HiDockDevice {
  id: string;
  name: string;
  model: string;
  serialNumber: string;
  firmwareVersion: string;
  connected: boolean;
  storageInfo?: StorageInfo;
}

export interface StorageInfo {
  totalSpace: number;
  usedSpace: number;
  freeSpace: number;
  fileCount: number;
}

export interface AudioRecording {
  id: string;
  fileName: string;
  size: number;
  duration: number;
  dateCreated: Date;
  fileVersion: number;
  signature?: Uint8Array;
}
