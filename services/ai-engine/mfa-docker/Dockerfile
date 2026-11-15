# =============================================================================
# pinglc-mfa —— Montreal Forced Aligner 固定版本镜像（词级/音素级强制对齐）
#
# 设计要点：
# - 版本锁死：MFA=3.4.3（conda-forge）、基镜像固定 tag；conda 依赖闭包的
#   解析结果存 /opt/mfa-env.lock 供复现与排障（严格复现需 conda lock 文件，
#   暂未引入）；声学模型/词典版本由 engine-setup.sh 内 URL 锁定
# - 离线就绪：模型由 engine-setup.sh 宿主侧预下载到 mfa-docker/models/
#   （不入 git），构建期 COPY 进镜像层，运行期无需联网——不在容器内下载
#   （GitHub 资产在国内网络下即使走代理也易长传断流，宿主 curl 可重试续传）
# - 纯 CPU 任务：MFA 对齐不占 GPU，与 STT 推理无显存争用
# - 调用契约（未来 align_mfa handler）：
#     docker run --rm --user $(id -u):$(id -g) \
#       -v <corpus目录>:/work/corpus -v <输出目录>:/work/out -v <tmp目录>:/work/tmp \
#       pinglc-mfa:latest mfa align /work/corpus <dict> <acoustic> /work/out \
#         --temporary_directory /work/tmp
#     说明：模型烘焙于固定路径 /opt/mfa（MFA_ROOT_DIR，与运行 uid 无关、
#     全局可读），任意 --user 均可读；可写临时目录用 --temporary_directory
#     指到挂载点——不要用 -e HOME=… 覆盖（MFA 缺省把 $HOME/Documents/MFA
#     当模型根，覆盖 HOME 会让烘焙模型「消失」）
# =============================================================================

# micromamba 微型基镜像（conda-forge 官方维护，锁 tag 保证可复现）
FROM mambaorg/micromamba:2.10.0-ubuntu24.04

# MFA 版本（conda-forge 渠道锁定）
ARG MFA_VERSION=3.4.3

# 构建期步骤以 root 执行：基镜像可能以非 root 用户为默认（/opt 对其只读），
# 写 /opt/mfa-env.lock 与模型根 /opt/mfa 都需要 root；运行期以任意 --user 进入
USER root

# 独立 conda 环境安装 MFA；解析清单存镜像内（复现/排障），clean 收缩体积
RUN micromamba create -y -n mfa -c conda-forge \
      "montreal-forced-aligner=${MFA_VERSION}" \
    && micromamba list -n mfa > /opt/mfa-env.lock \
    && micromamba clean --all --yes

# mfa CLI 直达 PATH（ENV_NAME 供基镜像入口脚本激活；显式 PATH 双保险）。
# MFA_ROOT_DIR 固定模型根：缺省 $HOME/Documents/MFA 会以构建用户（root）
# 落盘且 /root 通常 0700，非 root 运行读不到；固定到 /opt/mfa 与 uid 解耦
ENV ENV_NAME=mfa \
    MFA_ROOT_DIR=/opt/mfa \
    PATH=/opt/conda/envs/mfa/bin:$PATH

# 烘焙两套英语声学模型+发音词典（宿主侧预下载，见文件头）：
#   english_us_arpa —— 经典 GMM 声学模型，体量小、行为稳
#   english_mfa     —— MFA 官方现代默认，精度更好（跟读评分首选）
# 目录层级对齐 MFA 惯例（abc.py: pretrained_directory）：
#   $MFA_ROOT_DIR/pretrained_models/{acoustic,dictionary}/…
# a+rwX 说明：MFA 每次调用都会往 $MFA_ROOT_DIR 写 global_config.yaml 与
# command_history.yaml（config.py: get_temporary_directory 即根目录），
# 任意 --user 运行需对根可写；写入落在容器可写层，随 --rm 丢弃不影响镜像
COPY models/ /opt/mfa/pretrained_models/
RUN chmod -R a+rwX /opt/mfa
