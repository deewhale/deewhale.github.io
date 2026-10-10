---
layout: post
title: "结构化输出：从 Schema 合规到发票入账"
description: "沿一张金额与订单号抽错、结构却完全合法的发票，展示金额校验、主数据查询、原文证据和中国数电发票查验如何共同决定能否自动入账。"
image: /assets/images/posts/structured-output-invoice-validation.jpg
image_alt: "桌上的财务单据、计算器和笔"
date: 2026-10-08 12:00:00 +0800
last_modified_at: 2026-10-10 12:00:00 +0800
categories: [AI, Engineering]
tags: [Structured Output, JSON Schema, Document AI]
---

![桌上的财务单据、计算器和笔](/assets/images/posts/structured-output-invoice-validation.jpg)

*摄影：Kelly Sikkema / Unsplash；裁切。*

下面是一组为说明校验机制而设计的假设字段，不对应真实发票或采购订单。

```json
{
  "net_amount": "7292.04",
  "tax_amount": "947.96",
  "invoice_total": "8420.00",
  "currency": "CNY",
  "purchase_order": "PO-1847"
}
```

这段 JSON 可以顺利反序列化。字段、类型和格式都符合约定。问题藏在值里：未税金额与税额相加应为 8,240 元；源发票上的订单号也是 `PO-1842`，并非 `PO-1847`。

如果流水线在 JSON Schema 通过后就入账，两处抽取错误会直接变成财务事实。结构化输出解决的是模型与软件之间的接口摩擦，财务系统还要判断字段是否彼此一致、是否对应真实订单，以及这些值究竟来自文档哪里。

我的判断是，结构化输出的落库状态应该叫 `schema_valid_candidate`，而不是 `validated_invoice`。一个名字上的克制，可以阻止下游把“程序能接收”误读成“业务已确认”。

## Schema 交付稳定接口

普通 JSON mode 主要保证结果可以解析；严格结构化输出再约束字段、类型、枚举和嵌套关系。常见实现会在生成每个 token 时，根据已经生成的内容和文法屏蔽非法候选。OpenAI 公开的实现会把受支持的 JSON Schema 转换为上下文无关文法；XGrammar 展示了另一套文法执行和缓存优化方法。

这项能力把括号闭合、字段名和数据形状变成接口层可以执行的契约。它对 8,240 和 8,420 却一视同仁——两者都是合法数字。OpenAI 的产品说明也明确保留了值错误、拒答、截断和 Schema 子集等处理边界。

2026 年的 Structured Output Benchmark 把结构与值分开测量。在其数据上，21 个模型大多保持很高的 Schema 合规，最佳 leaf-value 精确匹配率在文本、OCR 文档和音频上分别为 83.0%、67.2% 和 23.7%。图像组只有 209 条记录，输入还经过 OCR 和文本归一化，这些数字不能当成发票系统的生产准确率。它们说明的是评测方法：结构合规率与字段值正确率必须分别统计。

## 金额关系可以直接执行

发票金额校验无需再调用一次模型。下面这段只依赖 Python 标准库的代码可以直接运行：它用 `Decimal` 保存金额，在候选对象构造时检查价税关系，再查询采购订单主数据：

```python
from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol


@dataclass(frozen=True)
class InvoiceCandidate:
    net_amount: Decimal
    tax_amount: Decimal
    invoice_total: Decimal
    currency: str
    supplier_tax_id: str
    purchase_order: str

    def __post_init__(self) -> None:
        expected = (self.net_amount + self.tax_amount).quantize(Decimal("0.01"))
        if expected != self.invoice_total:
            raise ValueError(f"invoice_total should be {expected}")


class OrderRepository(Protocol):
    def matches(self, po: str, supplier_tax_id: str, currency: str) -> bool: ...


def validate_order(invoice: InvoiceCandidate, orders: OrderRepository) -> None:
    if not orders.matches(
        invoice.purchase_order,
        invoice.supplier_tax_id,
        invoice.currency,
    ):
        raise ValueError("purchase order does not match supplier and currency")
```

`Decimal` 避免把二进制浮点误差混入两位小数的金额判断。生产实现还要写清舍入方式、折扣、附加费、预付金额和红字场景。Peppol BIS Billing 的金额规则展示了这种做法：行净额合计、单据级调整、未税总额、税额、含税总额和应付金额之间都有独立等式。它不是中国发票的法定模板，但规则形状值得借鉴。

如果只能先加一道业务校验，我会从金额等式开始。它确定、便宜、覆盖面广，而且失败时不会诱使系统猜测哪个原字段才对。金额不平就转人工复核；程序可以给出期望值，却不替财务人员修改原始票据。

订单号需要另一类证据。`PO-1847` 即使符合正则，也可能不存在、属于另一家供应商或已经关闭。查询必须同时带上供应商、法人、币种和订单状态。发票号重复、供应商身份和收款信息也应分别交给拥有事实的系统，而非继续扩大 JSON Schema。

## 中国数电发票的本地校验

国家税务总局 2024 年第 11 号公告自 2024 年 12 月 1 日起在全国正式推广数电发票。公告列出的基本内容包括发票号码、开票日期、购销双方信息、项目、数量、单价、金额、税率、税额、合计和价税合计；发票号码为 20 位，由全国统一赋予。官方同时提供税务数字账户、电子发票服务平台和全国增值税发票查验平台，用于查询、下载、入账标识和票面信息查验。

这些本地事实会改变校验顺序：

- 对带价税合计大写、小写栏位的版式，可先将两者规范化为同一十进制值，再与金额、税额合计比较。
- 用 `发票号码 + 开票方税号` 查询本地已处理记录，可以在进入付款流程前拦截重复提交。
- 税务平台的查验结果用于确认票面信息及发票状态；采购订单、收货和付款授权仍由企业内部系统确认。
- 红字数电发票与蓝字发票存在关联关系，已确认用途或入账的蓝票还会影响红冲流程，不能把负金额简单视为普通发票。

我不建议把“可以在官方平台查验”直接写成“存在可自由调用的公共 API”。官方公告确认了查验服务，并未因此授予任意系统自动抓取或批量调用的接口。生产系统应使用组织已经获授权的税务集成；没有集成条件时，把查验作为人工或批量导入步骤，并记录查验时间与结果。

全国增值税发票查验平台自己也给出了重要边界：它提供票面信息查验；若票面与实际交易不符，仍需拒收或报告。查验成功可以证明一张票在税务系统中的状态，采购合同、货物是否收到、付款账户是否可信，要继续由其他证据回答。

## 关键字段携带原文证据

跨字段等式可能在“整组数字都抄错”时继续成立。一张虚假单据也能做到内部自洽。因此，应付金额、供应商、发票号和订单号需要保留可复核的原文位置。

```json
{
  "field": "invoice_total",
  "raw_text": "¥8,240.00",
  "normalized_value": "8240.00",
  "page": 1,
  "bounding_box": [0.71, 0.82, 0.91, 0.86],
  "parser_version": "invoice-extractor-2026-10"
}
```

Google Document AI 的公开数据模型把 `mentionText`、`normalizedValue`、`textAnchor` 和 `pageAnchor` 分开保存，说明这类记录可以作为解析接口的一部分。复核界面由此能够直接高亮“价税合计”区域，而非让财务人员重新浏览整张票。

原文、规范化值和外部补全也要分开。把 `2026/10/08` 规范化为 `2026-10-08`，仍然对应原文；从供应商主数据补出文档上没有的地址，则属于 enrichment。两者混在一个字段里，系统就失去了说明值来源的能力。

锚点提供可定位、可复核的证据，并不保证 OCR 选中了正确数字。高风险字段适合同时要求原文锚点、确定性业务规则和权威系统匹配；备注字段可以采用更便宜的门槛。模型置信度只用于路由，阈值应按字段、版式和解析器版本在自己的标注集上校准。

## 失败路由和上线指标

不同失败需要不同动作。解析或 Schema 错误停在接口层；金额不平、订单不匹配和重复发票进入业务拒绝；关键字段缺少锚点或存在多个候选位置时，进入字段级人工复核；新供应商、账户变更和超授权金额则交给额外审批。

评测也要落到入账决定，而不是 JSON parser：

| 指标 | 计算方式 | 上线门槛示例 |
|---|---|---|
| 结构合规率 | 可通过版本化 Schema 的输出 / 全部输出 | 自动路径必须为 100% |
| 关键字段精确率 | 金额、税号、发票号、订单号逐字段对比标注 | 未达团队风险预算即转人工 |
| 业务误放率 | 含已知业务错误却进入自动入账的样本 / 错误样本 | 冻结高风险测试集为 0 |
| 证据覆盖率 | 具有有效原文锚点的关键字段 / 关键字段 | 自动入账记录必须为 100% |
| 人工复核率 | `needs_review` / 全部单据 | 用于容量规划，不单独作为质量目标 |

表中的 100% 约束只针对接口和每笔自动入账记录的必备证据；它不声称模型在所有输入上都能抽对。真实版式中的模糊扫描、跨页表格、中英文混排、红字、多个金额区块和历史模板，都应保留在冻结样本里。模型、提示词、OCR、Schema、归一化代码或业务规则变化后，用同一批样本重新回放。

最终允许自动入账的记录应同时满足：结构完整，金额与其他硬规则成立，关键字段具有原文锚点，订单及供应商主数据在同一校验时点有效，发票完成适用的税务查验，风险策略允许自动处理。任何条件缺失，状态保持为 `needs_review` 或 `rejected`。

## 资料

- Introducing Structured Outputs in the API
- XGrammar: Flexible and Efficient Structured Generation Engine for Large Language Models
- JSONSchemaBench: A Rigorous Benchmark of Structured Outputs for Language Models
- The Structured Output Benchmark: A Multi-Source Benchmark for Evaluating Structured Output Quality in Large Language Models
- Peppol BIS Billing 3.0
- Document AI Document reference
- 国家税务总局关于推广应用全面数字化电子发票的公告
- 关于启用全国增值税发票查验平台的公告
