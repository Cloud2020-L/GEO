import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { RootState } from '../store';
import { authLogin, authRegister } from 'services/zggeo-api';
import {
  clearZggeoLocalCaches,
  getAuthToken,
  getStoredUser,
  removeAuthStorage,
  setAuthToken,
  setStoredUser,
} from 'utils/scopedStorage';

const namespace = 'user';
const persistedToken = getAuthToken();

const initialState = {
  token: persistedToken,
  userInfo: getStoredUser(),
};

// login
// 注意：不要用 createAsyncThunk 的默认 throw 路径，那条路径会把 axios 错误
// 序列化成 { name, message } 丢掉 response.data。改用 rejectWithValue 显式带上
// 后端 detail，Login 组件才能把 "Invalid email or password" 提示给用户。
export const login = createAsyncThunk<
  { token: string; user: Record<string, any> },
  Record<string, unknown>,
  { rejectValue: string }
>(`${namespace}/login`, async (userInfo, { rejectWithValue }) => {
  const username = String(userInfo.username || userInfo.account || userInfo.email || '').trim();
  const password = String(userInfo.password || '');
  if (!username || !password) {
    return rejectWithValue('请输入用户名和密码');
  }
  try {
    const res = await authLogin({ username, password });
    const token = String(res?.token || '');
    const user = (res?.user || {}) as Record<string, any>;
    if (!token) {
      return rejectWithValue('后端未返回登录令牌，请联系管理员');
    }
    clearZggeoLocalCaches();
    setStoredUser(user);
    return { token, user };
  } catch (err: any) {
    // axios 错误：优先透出后端 detail；再退回 message；再退回通用文案
    const detail = err?.response?.data?.detail;
    const status = err?.response?.status;
    if (typeof detail === 'string' && detail) {
      return rejectWithValue(detail);
    }
    if (status === 401) {
      return rejectWithValue('邮箱或密码错误');
    }
    if (err?.code === 'ERR_NETWORK' || err?.message === 'Network Error') {
      return rejectWithValue('无法连接后端服务（/api/zggeo），请确认 ai-service 是否在 :8010 运行');
    }
    return rejectWithValue(err?.message || '登录失败');
  }
});

export const registerClient = createAsyncThunk<
  { token: string; user: Record<string, any> },
  { name: string; phone: string; verification_code: string; password: string; company?: string },
  { rejectValue: string }
>(`${namespace}/registerClient`, async (payload, { rejectWithValue }) => {
  try {
    const res = await authRegister(payload);
    const token = String(res?.token || '');
    const user = (res?.user || {}) as Record<string, any>;
    if (!token) {
      return rejectWithValue('注册成功但后端未返回登录令牌，请联系管理员');
    }
    clearZggeoLocalCaches();
    setStoredUser(user);
    return { token, user };
  } catch (err: any) {
    const detail = err?.response?.data?.detail;
    if (typeof detail === 'string' && detail) {
      return rejectWithValue(detail);
    }
    return rejectWithValue(err?.message || '注册失败，请稍后重试');
  }
});

// getUserInfo
export const getUserInfo = createAsyncThunk(`${namespace}/getUserInfo`, async (_, { getState }: any) => {
  const { token } = getState();
  if (!token) return {};
  return getStoredUser();
});

const userSlice = createSlice({
  name: namespace,
  initialState,
  reducers: {
    logout: (state) => {
      clearZggeoLocalCaches();
      removeAuthStorage();
      state.token = '';
      state.userInfo = {};
    },
    remove: (state) => {
      state.token = '';
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(login.fulfilled, (state, action) => {
        setAuthToken(action.payload.token);

        state.token = action.payload.token;
        state.userInfo = action.payload.user;
      })
      .addCase(registerClient.fulfilled, (state, action) => {
        setAuthToken(action.payload.token);

        state.token = action.payload.token;
        state.userInfo = action.payload.user;
      })
      .addCase(getUserInfo.fulfilled, (state, action) => {
        state.userInfo = action.payload;
      });
  },
});

export const selectListBase = (state: RootState) => state.listBase;

export const { logout, remove } = userSlice.actions;

export default userSlice.reducer;
