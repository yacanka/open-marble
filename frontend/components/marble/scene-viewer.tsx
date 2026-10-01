'use client'

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { cn } from '@/lib/utils'

export type TransformMode = 'translate' | 'rotate' | 'scale'

export interface SceneViewerHandle {
  addModel: (glbUrl: string, name: string, defaultScale?: number) => void
  removeSelected: () => void
  setTransformMode: (mode: TransformMode) => void
}

interface SceneViewerProps {
  plyUrls: string[]
  className?: string
  onReady?: () => void
  onSelectModel?: (id: string | null) => void
  onTransformModeChange?: (mode: TransformMode) => void
}

interface PlacedMesh {
  id: string
  name: string
  object: import('three').Object3D
}

const SceneViewer = forwardRef<SceneViewerHandle, SceneViewerProps>(
  function SceneViewer(
    { plyUrls, className, onReady, onSelectModel, onTransformModeChange },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null)
    const internalsRef = useRef<{
      scene: import('three').Scene
      camera: import('three').PerspectiveCamera
      renderer: import('three').WebGLRenderer
      splatViewer: any
      orbitControls: import('three/examples/jsm/controls/OrbitControls.js').OrbitControls
      transformControls: import('three/examples/jsm/controls/TransformControls.js').TransformControls
      placedMeshes: PlacedMesh[]
      selectedId: string | null
      animFrameId: number
    } | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    // Select a placed mesh and attach transform controls
    const selectMesh = useCallback(
      (hitId: string | null) => {
        const internals = internalsRef.current
        if (!internals) return

        internals.selectedId = hitId
        onSelectModel?.(hitId)

        // Detach transform controls first
        internals.transformControls.detach()

        // Highlight selected + attach gizmo
        for (const placed of internals.placedMeshes) {
          const isSelected = placed.id === hitId
          placed.object.traverse((child) => {
            if ((child as import('three').Mesh).isMesh) {
              const mesh = child as import('three').Mesh
              const mat = mesh.material as import('three').MeshStandardMaterial
              if (mat.emissive) {
                mat.emissive.setHex(isSelected ? 0x333366 : 0x000000)
              }
            }
          })
          if (isSelected) {
            internals.transformControls.attach(placed.object)
          }
        }
      },
      [onSelectModel],
    )

    // Initialize Three.js scene
    useEffect(() => {
      const container = containerRef.current
      if (!container) return

      let cancelled = false
      setLoading(true)
      setError(null)

      async function init() {
        const THREE = await import('three')
        const { OrbitControls } = await import(
          'three/examples/jsm/controls/OrbitControls.js'
        )
        const { TransformControls } = await import(
          'three/examples/jsm/controls/TransformControls.js'
        )
        const GaussianSplats3D = await import(
          '@mkkellogg/gaussian-splats-3d'
        )

        if (cancelled) return

        const width = container.clientWidth
        const height = container.clientHeight

        // Renderer
        const renderer = new THREE.WebGLRenderer({ antialias: true })
        renderer.setSize(width, height)
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
        renderer.outputColorSpace = THREE.SRGBColorSpace
        renderer.toneMapping = THREE.ACESFilmicToneMapping
        renderer.toneMappingExposure = 1.0
        container.appendChild(renderer.domElement)

        // Scene
        const scene = new THREE.Scene()

        // Camera
        const camera = new THREE.PerspectiveCamera(
          65,
          width / height,
          0.1,
          500,
        )
        const cameraDistance = Math.max(4, 3.5 + plyUrls.length * 1.35)
        camera.position.set(0, 1.5, cameraDistance)

        // Lights
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
        scene.add(ambientLight)
        const dirLight = new THREE.DirectionalLight(0xffffff, 1.2)
        dirLight.position.set(5, 10, 5)
        scene.add(dirLight)

        // Orbit Controls
        const orbitControls = new OrbitControls(camera, renderer.domElement)
        orbitControls.enableDamping = true
        orbitControls.dampingFactor = 0.1
        orbitControls.target.set(0, 0, 0)

        // Transform Controls (gizmo for move/rotate/scale)
        const transformControls = new TransformControls(
          camera,
          renderer.domElement,
        )
        transformControls.setMode('translate')
        transformControls.setSize(0.8)
        scene.add(transformControls.getHelper())

        // Disable orbit when dragging the gizmo
        transformControls.addEventListener('dragging-changed', (event) => {
          orbitControls.enabled = !event.value
        })

        // Gaussian Splat Viewer
        let splatViewer: any = null
        try {
          splatViewer = new GaussianSplats3D.Viewer({
            selfDrivenMode: false,
            renderer: renderer,
            camera: camera,
            useBuiltInControls: false,
            threeScene: scene,
            sharedMemoryForWorkers: false,
          })

          const sceneSpacing = 2.25
          const sceneCenter = (plyUrls.length - 1) / 2
          let loadedSceneCount = 0

          for (const [index, plyUrl] of plyUrls.entries()) {
            try {
              await splatViewer.addSplatScene(plyUrl, {
                splatAlphaRemovalThreshold: 5,
                showLoadingUI: false,
                position: [(index - sceneCenter) * sceneSpacing, 0, 0],
                rotation: [1, 0, 0, 0],
              })
              loadedSceneCount += 1
            } catch (sceneError) {
              console.error(
                `Failed to load scene layer ${index + 1}:`,
                sceneError,
              )
            }
          }

          if (loadedSceneCount === 0) {
            throw new Error('None of the generated scene layers could be loaded')
          }
        } catch (e) {
          console.error('Failed to load Gaussian Splat:', e)
          if (!cancelled)
            setError(
              `Failed to load 3D scene: ${e instanceof Error ? e.message : e}`,
            )
        }

        if (cancelled) {
          renderer.dispose()
          return
        }

        const internals = {
          scene,
          camera,
          renderer,
          splatViewer,
          orbitControls,
          transformControls,
          placedMeshes: [] as PlacedMesh[],
          selectedId: null as string | null,
          animFrameId: 0,
        }
        internalsRef.current = internals

        // Render loop
        function animate() {
          internals.animFrameId = requestAnimationFrame(animate)
          orbitControls.update()
          if (internals.splatViewer) {
            internals.splatViewer.update()
            internals.splatViewer.render()
          } else {
            renderer.render(scene, camera)
          }
        }
        animate()

        // Resize handling
        const resizeObserver = new ResizeObserver(() => {
          const w = container.clientWidth
          const h = container.clientHeight
          camera.aspect = w / h
          camera.updateProjectionMatrix()
          renderer.setSize(w, h)
        })
        resizeObserver.observe(container)

        // Click to select
        const raycaster = new THREE.Raycaster()
        const pointer = new THREE.Vector2()

        function onPointerDown(event: PointerEvent) {
          // Ignore if dragging the gizmo
          if (transformControls.dragging) return

          const rect = renderer.domElement.getBoundingClientRect()
          pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
          pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
          raycaster.setFromCamera(pointer, camera)

          const meshObjects = internals.placedMeshes.map((m) => m.object)
          const intersects = raycaster.intersectObjects(meshObjects, true)

          let hitId: string | null = null
          if (intersects.length > 0) {
            for (const placed of internals.placedMeshes) {
              let obj: import('three').Object3D | null =
                intersects[0].object
              while (obj) {
                if (obj === placed.object) {
                  hitId = placed.id
                  break
                }
                obj = obj.parent
              }
              if (hitId) break
            }
          }

          selectMesh(hitId)
        }
        renderer.domElement.addEventListener('pointerdown', onPointerDown)

        // Keyboard shortcuts: W=translate, E=rotate, R=scale, Esc=deselect, Delete=remove
        function onKeyDown(event: KeyboardEvent) {
          // Don't capture keys if user is typing in an input
          if (
            event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLTextAreaElement
          )
            return

          switch (event.key.toLowerCase()) {
            case 'w':
              transformControls.setMode('translate')
              onTransformModeChange?.('translate')
              break
            case 'e':
              transformControls.setMode('rotate')
              onTransformModeChange?.('rotate')
              break
            case 'r':
              transformControls.setMode('scale')
              onTransformModeChange?.('scale')
              break
            case 'escape':
              selectMesh(null)
              break
            case 'delete':
            case 'backspace':
              if (internals.selectedId) {
                const idx = internals.placedMeshes.findIndex(
                  (m) => m.id === internals.selectedId,
                )
                if (idx !== -1) {
                  const [removed] = internals.placedMeshes.splice(idx, 1)
                  internals.scene.remove(removed.object)
                  transformControls.detach()
                  internals.selectedId = null
                  onSelectModel?.(null)
                }
              }
              break
          }
        }
        window.addEventListener('keydown', onKeyDown)

        setLoading(false)
        onReady?.()

        // Cleanup
        return () => {
          window.removeEventListener('keydown', onKeyDown)
          resizeObserver.disconnect()
          renderer.domElement.removeEventListener('pointerdown', onPointerDown)
          cancelAnimationFrame(internals.animFrameId)
          transformControls.dispose()
          if (internals.splatViewer) {
            try {
              internals.splatViewer.dispose()
            } catch {
              /* ignore */
            }
          }
          renderer.dispose()
          if (container.contains(renderer.domElement)) {
            container.removeChild(renderer.domElement)
          }
          internalsRef.current = null
        }
      }

      const cleanupPromise = init()

      return () => {
        cancelled = true
        cleanupPromise.then((cleanup) => cleanup?.())
      }
    }, [plyUrls, onReady, onSelectModel, onTransformModeChange, selectMesh])

    // Expose methods to parent
    const addModel = useCallback(
      async (glbUrl: string, name: string, defaultScale = 1.0) => {
        const internals = internalsRef.current
        if (!internals) return

        const THREE = await import('three')
        const { GLTFLoader } = await import(
          'three/examples/jsm/loaders/GLTFLoader.js'
        )

        const loader = new GLTFLoader()
        const gltf = await new Promise<
          import('three/examples/jsm/loaders/GLTFLoader.js').GLTF
        >((resolve, reject) => {
          loader.load(glbUrl, resolve, undefined, reject)
        })

        const model = gltf.scene
        model.scale.setScalar(defaultScale)

        // Place in front of camera
        const dir = new THREE.Vector3()
        internals.camera.getWorldDirection(dir)
        const pos = internals.camera.position
          .clone()
          .add(dir.multiplyScalar(3))
        model.position.copy(pos)
        model.position.y = 0

        internals.scene.add(model)

        const id = `model-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        internals.placedMeshes.push({ id, name, object: model })

        // Auto-select and attach gizmo
        selectMesh(id)
      },
      [selectMesh],
    )

    const removeSelected = useCallback(() => {
      const internals = internalsRef.current
      if (!internals || !internals.selectedId) return

      const idx = internals.placedMeshes.findIndex(
        (m) => m.id === internals.selectedId,
      )
      if (idx === -1) return

      const [removed] = internals.placedMeshes.splice(idx, 1)
      internals.scene.remove(removed.object)
      internals.transformControls.detach()
      internals.selectedId = null
      onSelectModel?.(null)
    }, [onSelectModel])

    const setTransformMode = useCallback((mode: TransformMode) => {
      const internals = internalsRef.current
      if (!internals) return
      internals.transformControls.setMode(mode)
    }, [])

    useImperativeHandle(
      ref,
      () => ({ addModel, removeSelected, setTransformMode }),
      [addModel, removeSelected, setTransformMode],
    )

    return (
      <div
        ref={containerRef}
        className={cn('relative h-full w-full', className)}
      >
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30">
            <p className="text-sm text-white/70">
              Loading{' '}
              {plyUrls.length > 1
                ? `${plyUrls.length} scene layers`
                : '3D scene'}
              ...
            </p>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}
      </div>
    )
  },
)

export { SceneViewer }
