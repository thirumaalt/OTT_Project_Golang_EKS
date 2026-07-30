package checks

import (
	"context"
	"fmt"

	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// Result is one row in the checklist — deliberately simple so the frontend
// doesn't need to know anything about how a check was performed.
type Result struct {
	Category string `json:"category"`
	Name     string `json:"name"`
	Status   string `json:"status"` // "pass", "fail", "unknown"
	Detail   string `json:"detail"`
	// Optional — only populated for checks that have a natural numeric
	// value worth graphing (currently just HPA CPU%). omitempty keeps
	// every other check's JSON exactly as it was.
	Current *int32 `json:"current,omitempty"`
	Target  *int32 `json:"target,omitempty"`
}

func pass(category, name, detail string) Result {
	return Result{Category: category, Name: name, Status: "pass", Detail: detail}
}
func fail(category, name, detail string) Result {
	return Result{Category: category, Name: name, Status: "fail", Detail: detail}
}

// K8sClients bundles both the typed clientset (for core resources like
// Pods/Deployments/HPAs) and the dynamic client (for CRDs like
// ExternalSecret and ArgoCD's Application, which don't have generated
// typed clients we can import here).
type K8sClients struct {
	Clientset *kubernetes.Clientset
	Dynamic   dynamic.Interface
}

// NewK8sClients builds both clients from in-cluster config — this only
// works when running inside a pod with a mounted ServiceAccount token,
// which is the whole point of the devops-dashboard-service RBAC/ServiceAccount.
func NewK8sClients() (*K8sClients, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, fmt.Errorf("loading in-cluster config: %w", err)
	}

	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("building clientset: %w", err)
	}

	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("building dynamic client: %w", err)
	}

	return &K8sClients{Clientset: clientset, Dynamic: dyn}, nil
}

// AllServices is the fixed list this whole project has used from Phase 7
// onward — kept here as the single source of truth for what "all 14
// services healthy" means.
var AllServices = []string{
	"auth-service", "user-service", "metadata-service", "recommendation-service",
	"watchhistory-service", "interaction-service", "subscription-service",
	"analytics-service", "api-gateway", "payment-service", "transcoding-service",
	"media-library-service", "frontend-ui", "admin-dashboard",
}

// CheckPods checks, per service, whether at least one pod is Running and
// Ready — not just "exists", since we've been burned repeatedly this
// project by pods that are Running but not actually doing anything
// (Promtail's 0/0 targets being the clearest example).
func CheckPods(ctx context.Context, c *K8sClients, namespace string) []Result {
	var results []Result

	for _, svc := range AllServices {
		pods, err := c.Clientset.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
			LabelSelector: "app=" + svc,
		})
		if err != nil {
			results = append(results, fail("Services", svc, "error listing pods: "+err.Error()))
			continue
		}

		if len(pods.Items) == 0 {
			results = append(results, fail("Services", svc, "no pods found"))
			continue
		}

		healthy := false
		for _, p := range pods.Items {
			if p.Status.Phase == corev1.PodRunning && isPodReady(p) {
				healthy = true
				break
			}
		}

		if healthy {
			results = append(results, pass("Services", svc, "Running and Ready"))
		} else {
			results = append(results, fail("Services", svc, fmt.Sprintf("phase=%s, not Ready", pods.Items[0].Status.Phase)))
		}
	}

	return results
}

func isPodReady(p corev1.Pod) bool {
	for _, cond := range p.Status.Conditions {
		if cond.Type == corev1.PodReady {
			return cond.Status == corev1.ConditionTrue
		}
	}
	return false
}

// CheckHPA confirms each HPA is actually reporting a real metric, not
// stuck on <unknown> (which happens if metrics-server isn't reachable,
// or the target Deployment has no resource requests set).
func CheckHPA(ctx context.Context, c *K8sClients, namespace string) []Result {
	var results []Result

	hpas, err := c.Clientset.AutoscalingV2().HorizontalPodAutoscalers(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return []Result{fail("Autoscaling", "HPA list", "error: "+err.Error())}
	}

	found := map[string]bool{}
	for _, hpa := range hpas.Items {
		found[hpa.Name] = true

		current, target, ok := hpaCPUValues(hpa)
		if !ok {
			results = append(results, fail("Autoscaling", hpa.Name, "metrics still <unknown>"))
			continue
		}

		r := pass("Autoscaling", hpa.Name, fmt.Sprintf("CPU %d%% / target %d%%", current, target))
		r.Current = &current
		r.Target = &target
		results = append(results, r)
	}

	for _, svc := range AllServices {
		if !found[svc] {
			results = append(results, fail("Autoscaling", svc, "no HPA object found"))
		}
	}

	return results
}

// hpaCPUValues extracts the actual current and target CPU percentages —
// what the UI needs to draw a real bar, not just a pass/fail dot. Returns
// ok=false if metrics-server hasn't reported anything yet.
func hpaCPUValues(hpa autoscalingv2.HorizontalPodAutoscaler) (current int32, target int32, ok bool) {
	for _, m := range hpa.Status.CurrentMetrics {
		if m.Resource != nil && m.Resource.Current.AverageUtilization != nil {
			current = *m.Resource.Current.AverageUtilization
			ok = true
		}
	}
	if !ok {
		return 0, 0, false
	}
	for _, m := range hpa.Spec.Metrics {
		if m.Resource != nil && m.Resource.Target.AverageUtilization != nil {
			target = *m.Resource.Target.AverageUtilization
		}
	}
	return current, target, true
}

// GetDeployedTag reads the image tag actually running for a service right
// now, straight from the live Deployment — this is "what's really
// deployed," independent of whatever the manifest in git says, which is
// exactly the distinction that mattered when the transcoding-service tag
// bump was forgotten earlier in this project (git and cluster silently
// disagreed while everything reported healthy).
func GetDeployedTag(ctx context.Context, c *K8sClients, namespace, serviceName string) (string, error) {
	dep, err := c.Clientset.AppsV1().Deployments(namespace).Get(ctx, serviceName, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	if len(dep.Spec.Template.Spec.Containers) == 0 {
		return "", fmt.Errorf("deployment %s has no containers", serviceName)
	}
	image := dep.Spec.Template.Spec.Containers[0].Image
	// image looks like ".../myflix/auth-service:v2" — split on the last ":"
	for i := len(image) - 1; i >= 0; i-- {
		if image[i] == ':' {
			return image[i+1:], nil
		}
	}
	return "", fmt.Errorf("no tag found in image %q", image)
}

// GroupVersionResource for CRDs since there's no generated typed client
// for them available here.
var externalSecretGVR = schema.GroupVersionResource{
	Group: "external-secrets.io", Version: "v1", Resource: "externalsecrets",
}
var argoApplicationGVR = schema.GroupVersionResource{
	Group: "argoproj.io", Version: "v1alpha1", Resource: "applications",
}

// CheckExternalSecrets confirms every ExternalSecret actually synced
// (SecretSynced), not just that the object exists — this is exactly the
// distinction that mattered for the myflix-razorpay-secret failure.
func CheckExternalSecrets(ctx context.Context, c *K8sClients, namespace string) []Result {
	var results []Result

	list, err := c.Dynamic.Resource(externalSecretGVR).Namespace(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return []Result{fail("Secrets", "ExternalSecret list", "error: "+err.Error())}
	}

	for _, item := range list.Items {
		name := item.GetName()
		conditions, found, _ := unstructuredNestedSlice(item.Object, "status", "conditions")
		if !found {
			results = append(results, fail("Secrets", name, "no status.conditions reported yet"))
			continue
		}

		synced := false
		for _, c := range conditions {
			cond, ok := c.(map[string]interface{})
			if !ok {
				continue
			}
			if cond["type"] == "Ready" && cond["status"] == "True" {
				synced = true
			}
		}

		if synced {
			results = append(results, pass("Secrets", name, "SecretSynced"))
		} else {
			results = append(results, fail("Secrets", name, "not synced — check kubectl describe externalsecret"))
		}
	}

	return results
}

func unstructuredNestedSlice(obj map[string]interface{}, fields ...string) ([]interface{}, bool, error) {
	cur := obj
	for i, f := range fields {
		if i == len(fields)-1 {
			val, ok := cur[f].([]interface{})
			return val, ok, nil
		}
		next, ok := cur[f].(map[string]interface{})
		if !ok {
			return nil, false, nil
		}
		cur = next
	}
	return nil, false, nil
}

// CheckArgoCD confirms the myflix Application is Synced — Degraded health
// is expected right now (payment-service) so we deliberately don't check
// health here, only sync status, to avoid a permanently-red check for a
// known, accepted state.
func CheckArgoCD(ctx context.Context, c *K8sClients) []Result {
	obj, err := c.Dynamic.Resource(argoApplicationGVR).Namespace("argocd").Get(ctx, "myflix", metav1.GetOptions{})
	if err != nil {
		return []Result{fail("GitOps", "ArgoCD Application", "error: "+err.Error())}
	}

	status, found, _ := unstructuredNestedString(obj.Object, "status", "sync", "status")
	if !found {
		return []Result{fail("GitOps", "ArgoCD Application", "no sync status reported yet")}
	}

	if status == "Synced" {
		return []Result{pass("GitOps", "ArgoCD Application", "Synced")}
	}
	return []Result{fail("GitOps", "ArgoCD Application", "status: "+status)}
}

func unstructuredNestedString(obj map[string]interface{}, fields ...string) (string, bool, error) {
	cur := obj
	for i, f := range fields {
		if i == len(fields)-1 {
			val, ok := cur[f].(string)
			return val, ok, nil
		}
		next, ok := cur[f].(map[string]interface{})
		if !ok {
			return "", false, nil
		}
		cur = next
	}
	return "", false, nil
}
