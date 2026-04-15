import type { ApiResponse } from '../api/types';

export const isAuthExpiredResponse = (response?: Pick<ApiResponse<any>, 'authExpired'> | null) =>
  Boolean(response?.authExpired);
