package checks

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/cloudfront"
	"github.com/aws/aws-sdk-go-v2/service/ecr"
	"github.com/aws/aws-sdk-go-v2/service/eks"
	"github.com/aws/aws-sdk-go-v2/service/elasticache"
	"github.com/aws/aws-sdk-go-v2/service/rds"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// AWSClients bundles every service client this dashboard needs. Credentials
// come from IRSA (see dashboard-iam-policy.json) — same auto-discovery
// pattern as transcoding-service and media-library-service, no static keys.
type AWSClients struct {
	EKS         *eks.Client
	RDS         *rds.Client
	ElastiCache *elasticache.Client
	S3          *s3.Client
	ECR         *ecr.Client
	CloudFront  *cloudfront.Client
}

func NewAWSClients(ctx context.Context, region string) (*AWSClients, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, fmt.Errorf("loading AWS config: %w", err)
	}

	return &AWSClients{
		EKS:         eks.NewFromConfig(cfg),
		RDS:         rds.NewFromConfig(cfg),
		ElastiCache: elasticache.NewFromConfig(cfg),
		S3:          s3.NewFromConfig(cfg),
		ECR:         ecr.NewFromConfig(cfg),
		CloudFront:  cloudfront.NewFromConfig(cfg),
	}, nil
}

func (c *AWSClients) CheckEKS(ctx context.Context, clusterName string) Result {
	out, err := c.EKS.DescribeCluster(ctx, &eks.DescribeClusterInput{Name: aws.String(clusterName)})
	if err != nil {
		return fail("Infrastructure", "EKS cluster", "error: "+err.Error())
	}
	status := string(out.Cluster.Status)
	if status == "ACTIVE" {
		return pass("Infrastructure", "EKS cluster", fmt.Sprintf("ACTIVE, v%s", aws.ToString(out.Cluster.Version)))
	}
	return fail("Infrastructure", "EKS cluster", "status: "+status)
}

func (c *AWSClients) CheckRDS(ctx context.Context, dbInstanceID string) Result {
	out, err := c.RDS.DescribeDBInstances(ctx, &rds.DescribeDBInstancesInput{
		DBInstanceIdentifier: aws.String(dbInstanceID),
	})
	if err != nil {
		return fail("Infrastructure", "RDS Postgres", "error: "+err.Error())
	}
	if len(out.DBInstances) == 0 {
		return fail("Infrastructure", "RDS Postgres", "instance not found")
	}
	status := aws.ToString(out.DBInstances[0].DBInstanceStatus)
	if status == "available" {
		return pass("Infrastructure", "RDS Postgres", "available")
	}
	return fail("Infrastructure", "RDS Postgres", "status: "+status)
}

func (c *AWSClients) CheckElastiCache(ctx context.Context, cacheClusterID string) Result {
	out, err := c.ElastiCache.DescribeCacheClusters(ctx, &elasticache.DescribeCacheClustersInput{
		CacheClusterId: aws.String(cacheClusterID),
	})
	if err != nil {
		return fail("Infrastructure", "ElastiCache Redis", "error: "+err.Error())
	}
	if len(out.CacheClusters) == 0 {
		return fail("Infrastructure", "ElastiCache Redis", "cluster not found")
	}
	status := aws.ToString(out.CacheClusters[0].CacheClusterStatus)
	if status == "available" {
		return pass("Infrastructure", "ElastiCache Redis", "available")
	}
	return fail("Infrastructure", "ElastiCache Redis", "status: "+status)
}

func (c *AWSClients) CheckS3(ctx context.Context, bucket string) Result {
	_, err := c.S3.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(bucket)})
	if err != nil {
		return fail("Infrastructure", "S3 media bucket", "error: "+err.Error())
	}
	return pass("Infrastructure", "S3 media bucket", "reachable")
}

// CheckECRImages checks that every service repo actually has at least one
// pushed image — matching the exact gap that would have caught the
// original "did we forget to push this one" class of mistake before it
// ever reached kubectl.
func (c *AWSClients) CheckECRImages(ctx context.Context, repoNames []string) []Result {
	var results []Result
	for _, repo := range repoNames {
		out, err := c.ECR.DescribeImages(ctx, &ecr.DescribeImagesInput{
			RepositoryName: aws.String("myflix/" + repo),
		})
		if err != nil {
			results = append(results, fail("Container Images", repo, "error: "+err.Error()))
			continue
		}
		if len(out.ImageDetails) == 0 {
			results = append(results, fail("Container Images", repo, "no images pushed"))
			continue
		}
		results = append(results, pass("Container Images", repo, fmt.Sprintf("%d image(s) pushed", len(out.ImageDetails))))
	}
	return results
}

// GetLatestECRTag returns the most recently pushed tag for a service's
// repo — this is "what's available to deploy," compared against
// GetDeployedTag's "what's actually running" to tell you whether a
// service is behind.
func (c *AWSClients) GetLatestECRTag(ctx context.Context, repo string) (string, error) {
	out, err := c.ECR.DescribeImages(ctx, &ecr.DescribeImagesInput{
		RepositoryName: aws.String("myflix/" + repo),
	})
	if err != nil {
		return "", err
	}
	if len(out.ImageDetails) == 0 {
		return "", fmt.Errorf("no images found")
	}

	latest := out.ImageDetails[0]
	for _, img := range out.ImageDetails {
		if img.ImagePushedAt != nil && latest.ImagePushedAt != nil && img.ImagePushedAt.After(*latest.ImagePushedAt) {
			latest = img
		}
	}

	if len(latest.ImageTags) == 0 {
		return "", fmt.Errorf("latest image has no tags")
	}
	return latest.ImageTags[0], nil
}

func (c *AWSClients) CheckCloudFront(ctx context.Context, distributionID string) Result {
	out, err := c.CloudFront.GetDistribution(ctx, &cloudfront.GetDistributionInput{
		Id: aws.String(distributionID),
	})
	if err != nil {
		return fail("CDN", "CloudFront distribution", "error: "+err.Error())
	}
	status := aws.ToString(out.Distribution.Status)
	if status == "Deployed" {
		return pass("CDN", "CloudFront distribution", "Deployed — "+aws.ToString(out.Distribution.DomainName))
	}
	return fail("CDN", "CloudFront distribution", "status: "+status)
}
