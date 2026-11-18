const bearerModeParameter = {
  name: 'X-Auth-Mode',
  in: 'header',
  required: false,
  description:
    'Set to bearer for a non-browser request without cookies. Bearer mode returns tokens in JSON. Default mode sets HttpOnly cookies and returns the user.',
  schema: { type: 'string', enum: ['bearer'] },
} as const;

export const authOpenApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'TechEniac LMS - Auth API',
    version: '0.1.0',
    description: 'Authentication and session management. Responses use Cache-Control: no-store.',
  },
  servers: [
    {
      url: 'http://localhost:4000/api/v1',
      description: 'Local development server',
    },
  ],
  paths: {
    '/auth/login': {
      post: {
        summary: 'Authenticate user credentials',
        parameters: [bearerModeParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email', maxLength: 254 },
                  password: { type: 'string', minLength: 1, maxLength: 128 },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'User returned with session cookies or explicit bearer tokens' },
          '401': { description: 'Invalid email or password' },
          '403': { description: 'Account deactivated or bearer mode disallowed' },
          '429': { description: 'Rate limit exceeded' },
        },
      },
    },
    '/auth/refresh': {
      post: {
        summary: 'Rotate refresh token and issue new access token',
        parameters: [bearerModeParameter],
        requestBody: {
          description:
            'Bearer mode requires a refresh token in the JSON body. Default mode reads the refreshToken cookie.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['refreshToken'],
                properties: { refreshToken: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Session rotated with cookies or explicit bearer tokens' },
          '401': { description: 'Invalid, expired, or replayed refresh token' },
          '403': { description: 'Bearer mode disallowed' },
          '429': { description: 'Rate limit exceeded' },
        },
      },
    },
    '/auth/logout': {
      post: {
        summary: 'Revoke active refresh token and clear cookies',
        responses: {
          '200': { description: 'Logged out successfully' },
        },
      },
    },
    '/auth/me': {
      get: {
        summary: 'Get authenticated user profile',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        responses: {
          '200': { description: 'User profile returned' },
          '401': { description: 'Unauthorized' },
        },
      },
    },
    '/auth/forgot-password': {
      post: {
        summary: 'Request a password reset email link',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email'],
                properties: {
                  email: { type: 'string', format: 'email' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Generic success message (no account enumeration)' },
          '429': { description: 'Rate limit exceeded' },
        },
      },
    },
    '/auth/verify-reset-token': {
      post: {
        summary: 'Check whether a password reset token is still usable',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token'],
                properties: { token: { type: 'string', minLength: 1 } },
              },
            },
          },
        },
        responses: {
          '200': {
            description:
              'Always 200. `data.valid` is false for malformed, expired, revoked or already-consumed tokens',
          },
          '400': { description: 'Token missing or empty' },
          '429': { description: 'Rate limit exceeded' },
        },
      },
    },
    '/auth/reset-password': {
      post: {
        summary: 'Reset password using reset token',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token', 'newPassword'],
                properties: {
                  token: { type: 'string' },
                  newPassword: { type: 'string', minLength: 10, maxLength: 64 },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Password reset successfully' },
          '401': { description: 'Invalid or expired reset token' },
        },
      },
    },
    '/auth/change-password': {
      post: {
        summary: 'Change password for authenticated user',
        parameters: [bearerModeParameter],
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['currentPassword', 'newPassword'],
                properties: {
                  currentPassword: { type: 'string' },
                  newPassword: { type: 'string', minLength: 10, maxLength: 64 },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Password changed and session renewed with cookies or bearer tokens',
          },
          '401': { description: 'Incorrect current password or unauthenticated' },
          '403': { description: 'Bearer mode disallowed' },
        },
      },
    },
    '/auth/profile': {
      patch: {
        summary: 'Update authenticated user profile name',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', minLength: 2, maxLength: 100 },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Profile updated successfully returning updated user payload',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    message: { type: 'string', example: 'Profile updated successfully' },
                    data: {
                      type: 'object',
                      properties: {
                        user: {
                          type: 'object',
                          properties: {
                            id: { type: 'string', format: 'uuid' },
                            name: { type: 'string' },
                            email: { type: 'string', format: 'email' },
                            role: { type: 'string', enum: ['SUPER_ADMIN', 'MENTOR', 'MENTEE'] },
                            mustChangePassword: { type: 'boolean' },
                            isActive: { type: 'boolean' },
                            createdAt: { type: 'string', format: 'date-time' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Validation error' },
          '401': { description: 'Unauthorized' },
          '403': { description: 'Password change required (PASSWORD_CHANGE_REQUIRED)' },
          '404': { description: 'User not found' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'accessToken',
      },
    },
  },
} as const;

export default authOpenApiSpec;
