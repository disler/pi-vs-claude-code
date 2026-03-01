# LibreChat on Kubernetes

LibreChat is an open-source AI chat platform with support for multiple LLM providers, conversation management, and a modern UI.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Ingress (HTTPS)                        │
│                   librechat.example.com                     │
└─────────────────────────┬───────────────────────────────────┘
                          │
          ┌───────────────┴───────────────┐
          │                               │
          ▼                               ▼
┌───────────────────┐         ┌───────────────────┐
│   Frontend        │         │    Backend        │
│   (2 replicas)    │◄───────►│   (2 replicas)    │
│   Port: 3080      │         │   Port: 3080      │
└───────────────────┘         └─────────┬─────────┘
                                        │
                                        ▼
                          ┌─────────────────────────┐
                          │      MongoDB            │
                          │   (StatefulSet)         │
                          │   5Gi persistent        │
                          └─────────────────────────┘
```

## Directory Structure

```
librechat/
├── namespace.yaml      # Namespace definition
├── configmap.yaml      # Application configuration
├── secret.yaml         # Sensitive data (API keys, passwords)
├── mongodb.yaml        # MongoDB StatefulSet + Service
├── backend.yaml        # Backend Deployment + Service + RBAC
├── frontend.yaml       # Frontend Deployment + Service
├── ingress.yaml        # Ingress for external access
└── argocd-app.yaml     # ArgoCD Application manifest
```

## Quick Start

### 1. Prerequisites

- Kubernetes cluster (1.25+)
- ArgoCD installed
- NGINX Ingress Controller
- cert-manager (for TLS)
- Docker image pull access to GHCR

### 2. Configure Secrets

**Required:** Edit `secret.yaml` with your credentials:

```bash
cd librechat
vi secret.yaml
```

Update these values:
- `MONGO_ROOT_PASSWORD` - MongoDB root password
- `MONGODB_PASSWORD` - Application database password
- `JWT_SECRET` - Secure random string for sessions
- `OPENAI_API_KEY` - Your OpenAI API key (optional)
- `ANTHROPIC_API_KEY` - Your Anthropic API key (optional)
- `GOOGLE_API_KEY` - Your Google API key (optional)

### 3. Configure Ingress

Edit `ingress.yaml` with your domain:

```yaml
spec:
  rules:
  - host: librechat.your-domain.com  # Change this!
    tls:
    - hosts:
      - librechat.your-domain.com    # Change this!
      secretName: librechat-tls
```

### 4. Deploy via ArgoCD

**Option A - Apply directly:**
```bash
kubectl apply -f argocd-apps/librechat-app.yml
```

**Option B - Add to existing App-of-Apps:**
The ArgoCD app manifest is at `argocd-apps/librechat-app.yml`. If you use an App-of-Apps pattern, add it to your parent application's `argocd-apps/` directory.

**Option C - Via ArgoCD UI:**
1. Open ArgoCD dashboard
2. Click "New App"
3. Name: `librechat`
4. Repo URL: `https://github.com/lectriceye/argo-examples.git`
5. Path: `librechat`
6. Namespace: `librechat`
7. Enable "Automated Sync" and "Prune Resources"

### 5. Verify Deployment

```bash
# Check namespace
kubectl get ns librechat

# Check pods
kubectl get pods -n librechat

# Check services
kubectl get svc -n librechat

# Check ArgoCD sync status
argocd app get librechat
```

## Access

Once deployed:
- **Web UI:** https://librechat.your-domain.com
- **API:** https://librechat.your-domain.com/api

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment | `production` |
| `PORT` | Server port | `3080` |
| `MONGODB_URI` | MongoDB connection | `mongodb://mongodb:27017/librechat` |
| `JWT_SECRET` | Session secret | (required) |
| `OPENAI_API_KEY` | OpenAI API key | (optional) |
| `ANTHROPIC_API_KEY` | Anthropic API key | (optional) |
| `GOOGLE_API_KEY` | Google API key | (optional) |

### Resource Limits

| Component | CPU Request | CPU Limit | Memory Request | Memory Limit |
|-----------|-------------|-----------|----------------|--------------|
| Frontend | 100m | 500m | 256Mi | 512Mi |
| Backend | 250m | 1000m | 512Mi | 1Gi |
| MongoDB | 100m | 500m | 256Mi | 512Mi |

### Scaling

Edit replica counts in `frontend.yaml` and `backend.yaml`:

```yaml
spec:
  replicas: 3  # Change as needed
```

## Troubleshooting

### Pods not starting

```bash
# Check pod logs
kubectl logs -n librechat -l app=librechat-backend

# Check events
kubectl get events -n librechat --sort-by='.lastTimestamp'
```

### MongoDB connection issues

```bash
# Test MongoDB connectivity
kubectl exec -it -n librechat $(kubectl get pod -n librechat -l app=mongodb -o name) -- mongosh

# Check MongoDB service
kubectl get svc -n librechat mongodb
```

### Ingress not working

```bash
# Check ingress status
kubectl get ingress -n librechat

# Check ingress controller logs
kubectl logs -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx
```

## ArgoCD Sync Policy

The application uses automated sync with:
- **Prune:** Automatically removes resources no longer in the manifest
- **Self-heal:** Automatically syncs when cluster state drifts
- **CreateNamespace:** Automatically creates the librechat namespace

## Updating

### Via Git
```bash
# Update manifests
git pull

# ArgoCD will auto-sync (if enabled)
# Or manually trigger:
argocd app sync librechat
```

### Via ArgoCD UI
1. Open ArgoCD dashboard
2. Click on `librechat` application
3. Click "Sync" button

## Cleanup

```bash
# Delete via ArgoCD
argocd app delete librechat --cascade

# Or manually
kubectl delete namespace librechat
```

## References

- [LibreChat Official Docs](https://www.librechat.ai/docs)
- [ArgoCD Documentation](https://argo-cd.readthedocs.io/)
- [Kubernetes Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/)
