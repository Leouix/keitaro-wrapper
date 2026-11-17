import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Без globals:true RTL не регистрирует очистку сама.
afterEach(() => {
  cleanup();
});
