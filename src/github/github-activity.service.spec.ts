import { Test, TestingModule } from '@nestjs/testing';
import { GithubActivityService } from './github-activity.service';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { CommitsService } from './commits/commits.service';
import { PullRequestsService } from './pull-requests/pull-requests.service';
import { IssuesService } from './issues/issues.service';
import { CommentsService } from './comments/comments.service';
import { UserProfilesService } from './user-profiles/user-profiles.service';
import { AppConfigService } from '../config/app-config.service';
import { of } from 'rxjs';
import { IncrementalSyncService } from './incremental-sync.service';

describe('GithubActivityService', () => {
  let service: GithubActivityService;
  let mockCommitsService: jest.Mocked<CommitsService>;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockHttpService: jest.Mocked<HttpService>;
  let mockUserProfilesService: jest.Mocked<UserProfilesService>;
  let mockAppConfigService: jest.Mocked<AppConfigService>;

  beforeEach(async () => {
    const mockCommitsServiceProvider = {
      provide: CommitsService,
      useValue: {
        getCommitCount: jest.fn().mockResolvedValue(0),
        bulkUpsert: jest.fn().mockResolvedValue(undefined),
      },
    };

    const mockConfigServiceProvider = {
      provide: ConfigService,
      useValue: {
        get: jest.fn().mockReturnValue('mock-github-token'),
      },
    };

    const mockHttpServiceProvider = {
      provide: HttpService,
      useValue: {
        post: jest.fn().mockReturnValue(of({
          data: {
            data: {
              user: {
                login: 'testuser',
                name: 'Test User',
                bio: 'Test bio',
                avatarUrl: 'https://avatar.url',
                location: 'Test Location',
                company: 'Test Company',
                websiteUrl: 'https://test.com',
                twitterUsername: 'testuser',
                publicRepos: { totalCount: 10 },
                followers: { totalCount: 5 },
                following: { totalCount: 3 },
                createdAt: '2020-01-01T00:00:00Z',
                __typename: 'User',
                repositories: {
                  nodes: [
                    {
                      name: 'test-repo',
                      description: 'Test repository',
                      url: 'https://github.com/testuser/test-repo',
                      isFork: false,
                      isArchived: false,
                      owner: { login: 'testuser' },
                      stargazerCount: 5,
                      forkCount: 10 // This should be > minForkCount (3)
                    }
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null }
                }
              },
              repository: {
                defaultBranchRef: {
                  target: {
                    history: {
                      nodes: []
                    }
                  }
                },
                pullRequests: { nodes: [] },
                issues: { nodes: [] }
              }
            }
          },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {}
        } as any)),
      },
    };

    const mockUserProfilesServiceProvider = {
      provide: UserProfilesService,
      useValue: {
        findByUsername: jest.fn().mockResolvedValue(null),
        isProfileCacheValid: jest.fn().mockResolvedValue(false),
        upsert: jest.fn().mockResolvedValue({
          username: 'testuser',
          displayName: 'Test User',
          bio: 'Test bio',
          avatarUrl: 'https://avatar.url',
          location: 'Test Location',
          company: 'Test Company',
          blog: 'https://test.com',
          twitterUsername: 'testuser',
          email: null,
          publicRepos: 10,
          followers: 5,
          following: 3,
          accountType: 'User',
          createdAt: new Date('2020-01-01'),
        }),
      },
    };

    const mockAppConfigServiceProvider = {
      provide: AppConfigService,
      useValue: {
        minForkCount: 3,
        analysisStartDate: new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000), // 6 months ago
        maxPRsPerRepo: 100,
        cacheExpiryDate: new Date(Date.now() - 24 * 60 * 60 * 1000), // 24 hours ago
        enableIncrementalSync: false, // Disable incremental sync for tests
      },
    };

    const mockIncrementalSyncServiceProvider = {
      provide: IncrementalSyncService,
      useValue: {
        syncUserRepoActivity: jest.fn().mockResolvedValue({
          commits: 0,
          pullRequests: 0,
          issues: 0,
          prComments: 0,
          issueComments: 0,
          isIncremental: true,
          itemsFetched: 0,
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GithubActivityService,
        mockCommitsServiceProvider,
        mockConfigServiceProvider,
        mockHttpServiceProvider,
        mockUserProfilesServiceProvider,
        mockAppConfigServiceProvider,
        mockIncrementalSyncServiceProvider,
        {
          provide: PullRequestsService,
          useValue: { 
            getPRCount: jest.fn().mockResolvedValue(0), 
            bulkUpsert: jest.fn().mockResolvedValue(undefined) 
          },
        },
        {
          provide: IssuesService,
          useValue: { 
            getIssueCount: jest.fn().mockResolvedValue(0), 
            bulkUpsert: jest.fn().mockResolvedValue(undefined) 
          },
        },
        {
          provide: CommentsService,
          useValue: { 
            getCommentCount: jest.fn().mockResolvedValue(0), 
            bulkUpsert: jest.fn().mockResolvedValue(undefined) 
          },
        },
      ],
    }).compile();

    service = module.get<GithubActivityService>(GithubActivityService);
    mockCommitsService = module.get(CommitsService);
    mockConfigService = module.get(ConfigService);
    mockHttpService = module.get(HttpService);
    mockUserProfilesService = module.get(UserProfilesService);
    mockAppConfigService = module.get(AppConfigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getUserActivity', () => {
    it('should return activity data for valid usernames', async () => {
      const result = await service.getUserActivity(['testuser']);
      
      expect(result).toBeDefined();
      expect(result).toHaveProperty('users');
      expect(result).toHaveProperty('globalSummary');
      expect(Array.isArray(result.users)).toBe(true);
      expect(result.users).toHaveLength(1);
      expect((result.users[0] as any)).toHaveProperty('user');
      expect((result.users[0] as any)).toHaveProperty('repos');
      expect((result.users[0] as any)).toHaveProperty('summary');
      expect((result.users[0] as any).user.username).toBe('testuser');
      
      // Check global summary structure
      expect(result.globalSummary).toHaveProperty('totalCommits');
      expect(result.globalSummary).toHaveProperty('totalPRs');
      expect(result.globalSummary).toHaveProperty('totalIssues');
      expect(result.globalSummary).toHaveProperty('totalRepos');
      expect(result.globalSummary).toHaveProperty('successfulUsers');
      expect(result.globalSummary).toHaveProperty('totalUsers');
      expect(result.globalSummary.totalUsers).toBe(1);
    });

    it('should handle GitHub API errors gracefully', async () => {
      mockHttpService.post.mockReturnValueOnce(of({
        data: {
          errors: [{ message: 'API Error' }]
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {}
      } as any));

      const result = await service.getUserActivity(['testuser']);
      
      expect(result.users).toHaveLength(1);
      expect((result.users[0] as any).user).toHaveProperty('error');
      expect((result.users[0] as any).repos).toEqual([]);
      expect((result.users[0] as any).summary).toBeNull();
      
      // Check global summary accounts for failed users
      expect(result.globalSummary.failedUsers).toBe(1);
      expect(result.globalSummary.successfulUsers).toBe(0);
    });

    it('should use cached profile data when available', async () => {
      const cachedProfile = {
        username: 'testuser',
        displayName: 'Cached User',
        avatarUrl: 'https://cached.avatar.url',
      };

      mockUserProfilesService.findByUsername.mockResolvedValueOnce(cachedProfile as any);
      mockUserProfilesService.isProfileCacheValid.mockResolvedValueOnce(true);

      const result = await service.getUserActivity(['testuser']);

      expect(mockUserProfilesService.findByUsername).toHaveBeenCalledWith('testuser');
      expect(mockUserProfilesService.isProfileCacheValid).toHaveBeenCalled();
      expect(mockHttpService.post).toHaveBeenCalled(); // Will be called for repos and repo activity
      
      // Verify response structure
      expect(result).toHaveProperty('users');
      expect(result).toHaveProperty('globalSummary');
    });
  });

  describe('caching logic', () => {
    it('should use cached data when available', async () => {
      // Mock profile data first so the service doesn't fail early
      mockUserProfilesService.findByUsername.mockResolvedValueOnce({
        username: 'testuser',
        displayName: 'Test User',
      } as any);
      mockUserProfilesService.isProfileCacheValid.mockResolvedValueOnce(true);
      
      // Mock cached data available
      mockCommitsService.getCommitCount.mockResolvedValue(5);
      
      const result = await service.getUserActivity(['testuser']);
      
      expect(mockCommitsService.getCommitCount).toHaveBeenCalled();
      expect((result.users[0] as any).summary.totalCommits).toBe(5);
      expect(result.globalSummary.totalCommits).toBe(5);
    });

    it('should fetch fresh data when cache is empty', async () => {
      // Mock profile data first so the service doesn't fail early
      mockUserProfilesService.findByUsername.mockResolvedValueOnce({
        username: 'testuser',
        displayName: 'Test User',
      } as any);
      mockUserProfilesService.isProfileCacheValid.mockResolvedValueOnce(true);
      
      // Mock no cached data
      mockCommitsService.getCommitCount.mockResolvedValue(0);
      
      const result = await service.getUserActivity(['testuser']);
      
      expect(mockCommitsService.getCommitCount).toHaveBeenCalled();
      expect(mockHttpService.post).toHaveBeenCalled();
      expect(result).toHaveProperty('globalSummary');
    });
  });
});
